/**
 * 职责：管理端**客户**的只读仓储（AJ-404；对标分析 §4.5）——列表（分页 + 关键字）、详情（资料 / 统计 /
 *       地址簿 / 订单历史 / 拒付）与订单详情页的客户卡片统计。数据全部来自 users / orders / addresses / payments，不新增表。
 *
 * @why 客户 = `users.is_admin = false` 的行（含"只登录过、没下过单"的人）：小程序登录即建行（wechat-login.ts），
 *      只按"有订单"来定义会让"刚注册就被拉黑"的人在客户页里找不到。管理员与买家同表，必须显式排除。
 * @why 统计口径（**唯一出处**，改这里要同步契约描述与前端文案）：
 *      | 字段 | 口径 |
 *      |---|---|
 *      | `order_count` | 非测试单的全部订单（含过期 / 取消：它说的是"来下过几次单"） |
 *      | `paid_order_count` / `paid_total_jpy` | 非测试单里 `paid_at` 不为空的，`total_jpy` 求和（与工作台 `sales_jpy` 同口径，**不扣退款**） |
 *      | `last_order_at` / `first_order_at` | 非测试单的 `created_at` |
 *      | `contact_email` / `last_recipient` | 最近一张**非测试**单上留的（审核期测试单上是审核员的邮箱，不是这位客户的） |
 *      @tradeoff 累计金额不扣退款：扣了就要回答"部分退款按哪天、整单退款按哪笔"（dashboard.ts 那张口径表），
 *               客户卡片只要一个"这人大概买过多少"的量级；要精确净额看工作台与对账。
 * @why 关键字搜 **全部订单**（含测试单）+ 地址簿收件人 + 用户 id：搜索是"我要找这个人"的显式动作，
 *      与 `orders-admin.ts` @limitation 三同口径；`position(... in lower(...))` 而不是 `ilike`（`%` `_` 不当通配符）。
 * @why 订单历史**含测试单**并带 `is_test`：客服要能看到"这人的那张单是审核单"；统计则一律排除。
 *
 * @limitation 一：列表按"最近下单"排序要对每个客户先算聚合再排序，**没有索引能直接给出顺序**——
 *              @measured 2026-10-07 本机 PostgreSQL 16.15，`set local enable_seqscan = off` 后 EXPLAIN 列表查询：
 *              `Limit → Sort (Sort Key: max(o.created_at) FILTER (WHERE NOT o.is_test) DESC NULLS LAST, u.created_at DESC, u.id DESC)
 *               → Nested Loop Left Join → Seq Scan on users u (Filter: NOT is_admin)`；
 *              每位客户的聚合走 `Bitmap Index Scan on idx_orders_user_created (Index Cond: user_id = u.id)`，
 *              最近邮箱走 `Index Scan using idx_orders_user_created`。users 关掉 seqscan 仍是 Seq Scan（没有可用索引，
 *              也不需要：要的就是全部非管理员）。即 O(客户数) 次索引查找 + 一次排序；
 *              客户量到万级要考虑在 users 上冗余 `last_order_at`。
 *              拒付计数：`Index Scan using idx_orders_user_created` → `Index Scan using idx_payments_order`。
 * @limitation 二：关键字三处 OR（订单 / 地址簿 / id）没有可用索引（与 orders-admin.ts @limitation 一同一个原因），MVP 量级全扫无感。
 * @limitation 三：详情的订单历史最多 50 张（`ORDER_HISTORY_LIMIT`），更早的去订单页按人筛。统计不受这个上限影响。
 * @see app/admin-customer-routes.ts（唯一路由调用方）；app/admin-order-routes.ts（客户卡片）；
 *      contracts/api-contract.yaml 0.6.47（AdminCustomer*）
 */
import type { Db } from './db.js';

export const ORDER_HISTORY_LIMIT = 50;

export interface CustomerStats {
  orderCount: number;
  paidOrderCount: number;
  paidTotalJpy: number;
  testOrderCount: number;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
}

export interface CustomerListRow {
  id: string;
  createdAt: Date;
  blockedAt: Date | null;
  stats: CustomerStats;
  contactEmail: string | null;
  lastRecipient: string | null;
}

/** 每位客户一行的统计（lateral 子查询，走 idx_orders_user_created；口径见文件头表）。 */
const STATS_LATERAL = `
  left join lateral (
    select count(*) filter (where not o.is_test)::int as order_count,
           count(*) filter (where not o.is_test and o.paid_at is not null)::int as paid_order_count,
           coalesce(sum(o.total_jpy) filter (where not o.is_test and o.paid_at is not null), 0)::bigint
             as paid_total_jpy,
           count(*) filter (where o.is_test)::int as test_order_count,
           min(o.created_at) filter (where not o.is_test) as first_order_at,
           max(o.created_at) filter (where not o.is_test) as last_order_at
      from orders o where o.user_id = u.id
  ) s on true
  left join lateral (
    select o.contact_email, o.address_snapshot ->> 'recipient' as recipient
      from orders o where o.user_id = u.id and not o.is_test
     order by o.created_at desc limit 1
  ) lo on true
  left join lateral (
    select o.contact_email from orders o
     where o.user_id = u.id and not o.is_test and o.contact_email is not null
     order by o.created_at desc limit 1
  ) le on true`;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): Date | null => (v instanceof Date ? v : null);

function toStats(r: Record<string, unknown>): CustomerStats {
  return {
    orderCount: Number(r['order_count'] ?? 0),
    paidOrderCount: Number(r['paid_order_count'] ?? 0),
    paidTotalJpy: Number(r['paid_total_jpy'] ?? 0),
    testOrderCount: Number(r['test_order_count'] ?? 0),
    firstOrderAt: date(r['first_order_at']),
    lastOrderAt: date(r['last_order_at']),
  };
}

function toListRow(r: Record<string, unknown>): CustomerListRow {
  return {
    id: String(r['id']),
    createdAt: r['created_at'] as Date,
    blockedAt: date(r['blocked_at']),
    stats: toStats(r),
    contactEmail: str(r['contact_email']),
    lastRecipient: str(r['recipient']),
  };
}

/** 列表与计数共用的 WHERE（两条 SQL 条件一旦漂移，就是"第 1 页 3 行、total 说 5"）。 */
function customerWhere(db: Db, keyword: string | null) {
  return db`
    where u.is_admin = false
    ${
      keyword === null
        ? db``
        : db`and (
          position(${keyword} in lower(u.id)) > 0
          or exists (select 1 from orders o where o.user_id = u.id and (
               position(${keyword} in lower(o.order_no)) > 0
            or position(${keyword} in lower(coalesce(o.contact_email, ''))) > 0
            or position(${keyword} in lower(coalesce(o.address_snapshot ->> 'recipient', ''))) > 0))
          or exists (select 1 from addresses a where a.user_id = u.id
                      and position(${keyword} in lower(a.recipient)) > 0))`
    }`;
}

export async function listCustomers(
  db: Db,
  q: { page: number; size: number; keyword: string | null },
): Promise<{ items: CustomerListRow[]; total: number }> {
  const rows = await db`
    select u.id, u.created_at, u.blocked_at, s.*, le.contact_email, lo.recipient
      from users u ${db.unsafe(STATS_LATERAL)}
    ${customerWhere(db, q.keyword)}
     order by s.last_order_at desc nulls last, u.created_at desc, u.id desc
     limit ${q.size} offset ${(q.page - 1) * q.size}
  `;
  const counts = await db`select count(*)::int as n from users u ${customerWhere(db, q.keyword)}`;
  return {
    items: rows.map((r) => toListRow(r as Record<string, unknown>)),
    total: Number(counts[0]?.['n'] ?? 0),
  };
}

/** 单个客户的资料 + 统计；不存在或是管理员 → null（路由转 40403）。 */
export async function findCustomer(db: Db, id: string): Promise<CustomerListRow | null> {
  const rows = await db`
    select u.id, u.created_at, u.blocked_at, s.*, le.contact_email, lo.recipient
      from users u ${db.unsafe(STATS_LATERAL)}
     where u.id = ${id} and u.is_admin = false
  `;
  const r = rows[0];
  return r === undefined ? null : toListRow(r as Record<string, unknown>);
}

export interface CustomerAddressRow {
  id: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

/** 地址簿：默认地址在前，其余按建立时间。 */
export async function listCustomerAddresses(db: Db, userId: string): Promise<CustomerAddressRow[]> {
  const rows = await db`
    select id, recipient, phone, line1, line2, city, state, postal_code, country, is_default
      from addresses where user_id = ${userId}
     order by is_default desc, created_at, id
  `;
  return rows.map((r) => ({
    id: String(r['id']),
    recipient: String(r['recipient']),
    phone: String(r['phone']),
    line1: String(r['line1']),
    line2: str(r['line2']),
    city: String(r['city']),
    // CHAR(n) 列可能带尾部空格（dashboard.ts toMoney 同手法）
    state: String(r['state']).trim(),
    postalCode: String(r['postal_code']),
    country: String(r['country']).trim(),
    isDefault: r['is_default'] === true,
  }));
}

export interface CustomerOrderRow {
  id: string;
  orderNo: string;
  status: string;
  totalJpy: number;
  isTest: boolean;
  hasDispute: boolean;
  createdAt: Date;
  paidAt: Date | null;
}

/** 订单历史（新的在前，最多 ORDER_HISTORY_LIMIT 张；含测试单）。 */
export async function listCustomerOrders(db: Db, userId: string): Promise<CustomerOrderRow[]> {
  const rows = await db`
    select id, order_no, status, total_jpy, is_test, has_dispute, created_at, paid_at
      from orders where user_id = ${userId}
     order by created_at desc, id desc
     limit ${ORDER_HISTORY_LIMIT}
  `;
  return rows.map((r) => ({
    id: String(r['id']),
    orderNo: String(r['order_no']),
    status: String(r['status']),
    totalJpy: Number(r['total_jpy']),
    isTest: r['is_test'] === true,
    hasDispute: r['has_dispute'] === true,
    createdAt: r['created_at'] as Date,
    paidAt: date(r['paid_at']),
  }));
}

/**
 * 拒付计数：该客户名下全部支付行里 `dispute_id` 不为空的（判据与 risk-admin.ts listDisputes 同一条）；
 * 进行中 = 尚未结案（`dispute_closed_at is null`——结案时 mark-disputed.ts 同时写 status 与 closed_at，
 * 只看 status 会把"机构没报状态"的 null 行漏掉）。
 */
export async function countCustomerDisputes(
  db: Db,
  userId: string,
): Promise<{ total: number; open: number }> {
  const [r] = await db`
    select count(*)::int as total,
           count(*) filter (where p.dispute_closed_at is null)::int as open
      from payments p join orders o on o.id = p.order_id
     where o.user_id = ${userId} and p.dispute_id is not null
  `;
  return { total: Number(r?.['total'] ?? 0), open: Number(r?.['open'] ?? 0) };
}
