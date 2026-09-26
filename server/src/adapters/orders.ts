/**
 * 职责：`orders` 表的 SQL 仓储（I1-U2 起；U5 建单/查询会继续生长本文件）。
 *
 * 边界：只做 SQL 与行 ↔ 类型的映射，不含业务规则（状态机迁移表在 `domain/order.ts`，U5）。
 *
 * @why 关单扫描的两个 SQL 细节都是踩过坑才定下的，写在这里而不是散落在 job 里：
 *      ① `expires_at <= now`（**含等号**）——语义是"可支付窗口为 `[created, expires_at)`"：
 *         到点的这一瞬间就不可付了。mark-paid 守卫用**同一个**比较方向（`now >= expires_at` 即迟到），
 *         两边若一个含等号一个不含，"恰好在 expires_at 那一毫秒付款"的订单会同时被
 *         "关单 job 放过"和"落账守卫拒绝"，谁也解释不清它到底算不算超时。
 *      ② `FOR UPDATE SKIP LOCKED`——关单 job 与支付回调会**同时**盯上同一张单
 *         （用户在 29 分 59 秒付款、30 分 00 秒 tick 醒来）：
 *         行锁被落账事务持有时，扫描**跳过**这张单而不是整批卡死等锁；
 *         下一轮 tick 它若仍未支付自然会被再扫到。写成裸 `FOR UPDATE` 的后果是
 *         落账慢 5 秒、整批关单就堵 5 秒，且这种堵塞只在"快超时还在付"的真实场景才出现。
 *
 * @limitation 一：扫描限量（`LIMIT $3`）——单轮最多取 `limit` 条，剩余的**下一轮**再关。
 *              换来单轮事务时长有上界（D-43 进程内调度器，长事务会拖累整条连接池）；
 *              代价是积压时关单有延迟（每轮 60s × 每轮 limit 条），MVP 单量下可接受。
 * @limitation 二：`markOrderExpired` 的 WHERE 里重复了状态条件（不只靠扫描时的过滤）：
 *              扫描与更新之间若有人抢先改了状态（理论上同事务内不可能，但本函数也对
 *              事务外调用方开放），0 行命中 → 返回 false，调用方不得把它当错误。
 *
 * @see app/expire-orders.ts（消费方：超时关单 job）；migrations/001_init.sql（orders 表）；
 *      docs/I1阶段开发实施方案.md §3.2；D-33（30 分钟超时关单）
 */
import type { Db } from './db.js';

/**
 * 可支付状态：只有这两个状态的订单会被超时关单。
 * @why 不从 shared 的 ORDER_STATUS 推导子集——"哪些状态算可支付"是**业务判定**，
 *      显式写出来比在枚举里做索引切片可读，且加状态（如 `price_review`）时
 *      这里是编译期会逼你想一遍的地方。
 */
export const PAYABLE_STATUSES = ['created', 'pending_payment'] as const;

/**
 * 锁定并取出"到点未支付"的订单 id（按 expires_at 升序：最老的先关）。
 *
 * @param now 判定基准——**调用方必须传本轮 tick 的 startedAt**（ports/scheduler.ts
 *            JobContext.startedAt 的 @why：同一轮里所有 job 用同一个基准，
 *            否则边界订单的命运取决于它在队列里排第几）。
 */
export async function lockExpiredPayableOrders(
  tx: Db,
  now: Date,
  limit: number,
): Promise<string[]> {
  const rows = await tx`
    select id from orders
     where status in ${tx([...PAYABLE_STATUSES])}
       and expires_at <= ${now}
     order by expires_at asc
     limit ${limit}
     for update skip locked
  `;
  return rows.map((r) => String(r.id));
}

/**
 * 把一张订单关为 `expired` 并写审计事件（同一事务）。
 *
 * @returns true = 本次真的关了（随后应 emit `order.expired` + 释放库存）；
 *          false = 状态已被别人抢先迁走（0 行命中，**不是错误**，见文件头 @limitation 二）。
 */
export async function markOrderExpired(tx: Db, orderId: string, at: Date): Promise<boolean> {
  const updated = await tx`
    update orders
       set status = 'expired', updated_at = now()
     where id = ${orderId}
       and status in ${tx([...PAYABLE_STATUSES])}
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, actor, at)
    values (${orderId}, 'expired', 'system', ${at})
  `;
  return true;
}

// ── I1-U5b：建单 / 库存 ─────────────────────────────────────────────────────

/** 建单快照用的地址行（普通对象，见 findOwnedAddress 的 ⚠️）。 */
export interface OrderAddressSnapshot {
  id: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/**
 * 读取一张**确定属于该用户**的地址（建单快照的来源）。
 * @returns 地址行；不存在或非本人 → null（路由层判 40400，与订单归属同口径）。
 *
 * ⚠️ 必须**逐字段取值**返回普通对象，不能把 postgres.js 的行直接给 JSON.stringify：
 *    驱动的 Row 是**数组子类**（列名挂在命名属性上），`JSON.stringify(Row)` 只序列化
 *    数字索引 → 恒为 `'[]'`——快照落成空数组且**不报错**（接线测试实抓一次：
 *    address_snapshot.recipient 读回 undefined）。
 */
export async function findOwnedAddress(
  tx: Db,
  addressId: string,
  userId: string,
): Promise<OrderAddressSnapshot | null> {
  const rows = await tx`
    select id, recipient, phone, line1, line2, city, state, postal_code, country
      from addresses where id = ${addressId} and user_id = ${userId}
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r.id),
    recipient: String(r.recipient),
    phone: String(r.phone),
    line1: String(r.line1),
    line2: r.line2 === null ? null : String(r.line2),
    city: String(r.city),
    state: String(r.state),
    postal_code: String(r.postal_code),
    country: String(r.country),
  };
}

/**
 * 原子扣减库存（条件更新）：`stock >= qty` 才扣，一行都不满足则返回 false。
 *
 * @why 这是并发安全的**唯一**正确形态：先 SELECT 余量再 UPDATE 的写法，在两个请求
 *      同时买最后一件时，两边都读到 1、都扣成功 → 超卖（-1 被 CHECK 拦住时则是一边 500）。
 *      条件更新把"判定 + 扣减"压进一条语句，数据库用行锁保证只有一个成功者。
 *      建单事务里逐行调用：任一商品 false → 抛 40901 整单回滚（前面已扣的随行回滚）。
 */
export async function decrementStock(tx: Db, productId: string, qty: number): Promise<boolean> {
  const rows = await tx`
    update products set stock = stock - ${qty}, updated_at = now()
     where id = ${productId} and stock >= ${qty}
  `;
  return rows.count > 0;
}

/**
 * 按订单行项目恢复库存（关单/取消的释放）。
 *
 * ⚠️ **本函数不幂等**：调一次加一次。调用方必须用"状态迁移守卫"保证只调一次——
 *    `markOrderExpired` / cancel 的 update 带状态条件返回 true 的那一刻，
 *    就是"本次迁移是我干的"的排他凭证，释放跟在它后面（同事务）。
 *    脱离守卫直接调用 = 库存双倍回血（钱货两空的另一种形态）。
 */
export async function restoreStockForOrder(tx: Db, orderId: string): Promise<number> {
  const rows = await tx`
    update products p set stock = stock + oi.qty, updated_at = now()
      from order_items oi
     where oi.order_id = ${orderId} and oi.product_id = p.id
  `;
  return rows.count;
}

/** insertOrder 的行（JSONB 列传字符串，由 SQL 侧 ::jsonb 转换——postgres.js 数组进 jsonb 的坑见 F9）。 */
export interface OrderInsertRow {
  id: string;
  order_no: string;
  user_id: string;
  items_jpy: number;
  shipping_jpy: number;
  duty_jpy: number;
  total_jpy: number;
  weight_g: number;
  fx_snapshot: string;
  address_snapshot: string;
  contact_email: string | null;
  terms_version: string;
  expires_at: Date;
}

/**
 * 插入订单主行（status='created'）。
 * @throws {PostgresError} 23505（order_no 唯一冲突）——**调用方必须 savepoint 捕获重试**（D32）：
 *         PG 事务内一条语句报错后整个事务进入 aborted 状态，不回滚到 savepoint 就什么都不能再做。
 */
export async function insertOrder(tx: Db, row: OrderInsertRow): Promise<void> {
  await tx`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, contact_email,
                        terms_version, expires_at)
    values (${row.id}, ${row.order_no}, ${row.user_id}, 'created', ${row.items_jpy},
            ${row.shipping_jpy}, ${row.duty_jpy}, ${row.total_jpy}, ${row.weight_g},
            ${row.fx_snapshot}::jsonb, ${row.address_snapshot}::jsonb, ${row.contact_email},
            ${row.terms_version}, ${row.expires_at})
  `;
}

/** order_items 一行（declared_value_usd 由建单用 allocate 分摊好——这里只负责落库）。 */
export interface OrderItemInsertRow {
  id: string;
  order_id: string;
  product_id: string;
  title_snapshot: string;
  qty: number;
  unit_price_jpy: number;
  weight_g: number;
  declared_value_usd: number;
}

export async function insertOrderItems(
  tx: Db,
  items: readonly OrderItemInsertRow[],
): Promise<void> {
  for (const it of items) {
    await tx`
      insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                               weight_g, declared_value_usd)
      values (${it.id}, ${it.order_id}, ${it.product_id}, ${it.title_snapshot}, ${it.qty},
              ${it.unit_price_jpy}, ${it.weight_g}, ${it.declared_value_usd})
    `;
  }
}
