/**
 * 职责：管理端订单的**读**仓储（I2 U-B1）——列表（状态 / 关键字 / 分页）、详情主行、
 *      以及 items / payments / events 三张附属表的**批量**查询。
 *
 * @why 与 `orders.ts`（买家侧）**分成两个文件**：买家侧每条查询都带 `user_id =`
 *      （orders.ts @why：归属过滤进 WHERE，写错就是越权读取）。管理端若复用它们，
 *      要么伪造 user_id，要么把"跨用户"这个性质加到买家侧函数上——两者都会让
 *      "越权"变得难以一眼看出。分开后，"没有 user_id 过滤"是**本文件的固有属性**，
 *      而它的调用方只有一个（admin 路由，有 `requireAdmin` 守卫）。
 *
 * @why 附属数据走**批量**查询（`where order_id in (...)`）而不是按单循环：
 *      MVP 的列表页不补附属数据，但 `GET /admin/orders/{id}` 一次要 items+payments+events
 *      三类；哪天列表要显示商品图或"最近一条支付状态"，批量形态是唯一不必重写的写法。
 *      @tradeoff 换来的是"取附属数据必须先凑出 id 数组"这一层间接。
 *
 * @why keyword 用 `position(... in lower(col)) > 0` 而**不是** `ilike '%k%'`：
 *      ilike 的 `%` `_` 在用户输入里是通配符，不转义的话搜 "100%" 会变成"匹配一切"——
 *      一个只在用户手敲百分号时才出现的静默错误，且没有任何日志会记它。
 *      `position` 天生是子串语义，没有转义这回事，参数里出现什么都当普通字符。
 *
 * @limitation 一：keyword 三列 OR **没有任何索引**可用（orders 上只有
 *              `(user_id, created_at)` 与 `(status)` 两个索引，且 `address_snapshot->>'recipient'`
 *              是 JSONB 表达式索引才能命中的形态）。MVP 单量（百级）下全表扫无感；
 *              到万级要先加 pg_trgm 表达式索引，或把"单号"拆成精确匹配走 `order_no` 的唯一索引。
 * @limitation 二：id 数组为空时**直接返回空数组、不下 SQL**。
 *              ⚠️ 实测更正（U-B1 探针，推翻我原先"空数组会渲染成 `in ()` 语法错误"的断言）：
 *                 postgres.js 把空数组渲染成 **`in (null)`**——合法 SQL，返回 0 行，**不报错**。
 *                 所以这个守卫防的不是崩溃，防的是"把语义押在驱动对空数组的实现细节上"
 *                 （哪天渲染成 `()` 就是语法错误，而那时没有任何测试会提前知道）。
 *                 顺带省一次往返：列表页末页越界、`findAdminOrder` 后续批量查询都可能传空数组。
 * @limitation 三：`is_test` **默认过滤**（契约 `Order.is_test` 的描述），但**给了 keyword 就不过滤**：
 *              keyword 是"我就要找这一张单"的显式动作，而"单号确切存在、搜却搜不到"
 *              比"列表里多一行测试单"更糟——后者行里带 `is_test` 字段，运营看得见它是什么。
 *              @tradeoff 代价：同一张测试单"列表里看不到、搜却搜得到"，运营可能困惑；
 *              换来的是客服按单号救单时不会撞上"查无此单"。
 * @limitation 四：列表行是 `Order` 的**子集**（不带 items / address / timeline / payment）——
 *              契约 `/admin/orders` 的 items 声明为 `$ref: Order`，属"契约比实现严格"的漂移，
 *              已随 U-B1 收紧为 `AdminOrderListItem`（0.6.1）。真要给列表补附属数据，
 *              先改契约再改这里（顺序不能倒，否则又是注释与事实分离）。
 *
 * @see contracts/api-contract.yaml（AdminOrderListItem / AdminOrder）；
 *      migrations/001_init.sql（orders / order_items / payments / order_events）；
 *      app/admin-order-routes.ts（唯一调用方）
 */
import type { Db } from './db.js';

/** 列表行（`AdminOrderListItem`：OrderSummary + 管理端专有列）。 */
export interface AdminOrderListRow {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  total_jpy: number;
  contact_email: string | null;
  carrier: string | null;
  tracking_no: string | null;
  has_dispute: boolean;
  is_test: boolean;
  created_at: Date;
}

export interface AdminOrderListQuery {
  page: number;
  size: number;
  /** 不传 = 全部状态。 */
  status?: string | undefined;
  /** 单号 / 收件人 / 运单号 子串匹配（三列 OR，大小写无关）。 */
  keyword?: string | undefined;
  /** true = 连 `is_test` 的审核期 mock 单一起返回（见文件头 @limitation 三）。 */
  includeTest?: boolean | undefined;
}

/** 详情主行（SQL 里逐列取值，不做 `select *`：加列的当天这里会被编译器逼着想一遍）。 */
export interface AdminOrderRow {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  items_jpy: number;
  shipping_jpy: number;
  duty_jpy: number;
  total_jpy: number;
  weight_g: number;
  fx_snapshot: unknown;
  address_snapshot: unknown;
  contact_email: string | null;
  terms_version: string;
  charge_currency: string | null;
  charge_amount: number | null;
  carrier: string | null;
  tracking_no: string | null;
  has_dispute: boolean;
  is_test: boolean;
  expires_at: Date;
  paid_at: Date | null;
  shipped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AdminOrderItemRow {
  order_id: string;
  product_id: string;
  title_snapshot: string;
  qty: number;
  unit_price_jpy: number;
  weight_g: number;
  declared_value_usd: number;
}

export interface AdminPaymentRow {
  order_id: string;
  provider: string;
  provider_ref: string | null;
  transaction_id: string | null;
  status: string;
  charge_currency: string;
  charge_amount: number;
  paid_amount: number | null;
  paid_currency: string | null;
  settled_jpy: number | null;
  fee_jpy: number | null;
  created_at: Date;
}

export interface AdminOrderEventRow {
  order_id: string;
  status: string;
  note: string | null;
  actor: string | null;
  at: Date;
}

const LIST_COLS = [
  'id',
  'order_no',
  'user_id',
  'status',
  'total_jpy',
  'contact_email',
  'carrier',
  'tracking_no',
  'has_dispute',
  'is_test',
  'created_at',
];

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function bool(v: unknown): boolean {
  return v === true;
}

/** 关键字归一化：去空白 + 转小写；空串视为"没给"（否则 `position('' in x) > 0` 恒真 → 全表命中）。 */
function normalizeKeyword(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const k = raw.trim().toLowerCase();
  return k === '' ? null : k;
}

/**
 * 列表与计数**共用**的 WHERE 片段。
 * @why 抽成函数而不是在两条 SQL 里各写一遍：分页的两条语句一旦条件漂移，
 *      表现是"第 1 页显示 3 条、total 说 5 条"——没人会怀疑是两条 SQL 不一致。
 */
function buildWhere(db: Db, q: AdminOrderListQuery) {
  const kw = normalizeKeyword(q.keyword);
  const hideTest = q.includeTest !== true && kw === null;
  return db`
    where (${q.status === undefined ? db`true` : db`status = ${q.status}`})
      and (${hideTest ? db`is_test = false` : db`true`})
      ${
        kw === null
          ? db``
          : db`
        and (position(${kw} in lower(order_no)) > 0
          or position(${kw} in lower(coalesce(address_snapshot ->> 'recipient', ''))) > 0
          or position(${kw} in lower(coalesce(tracking_no, ''))) > 0)`
      }
  `;
}

function toListRow(r: Record<string, unknown>): AdminOrderListRow {
  return {
    id: String(r.id),
    order_no: String(r.order_no),
    user_id: String(r.user_id),
    status: String(r.status),
    total_jpy: Number(r.total_jpy),
    contact_email: strOrNull(r.contact_email),
    carrier: strOrNull(r.carrier),
    tracking_no: strOrNull(r.tracking_no),
    has_dispute: bool(r.has_dispute),
    is_test: bool(r.is_test),
    created_at: r.created_at as Date,
  };
}

/** 分页列表 + 总数（两条 SQL 共用 buildWhere）。 */
export async function listAdminOrders(
  db: Db,
  q: AdminOrderListQuery,
): Promise<{ items: AdminOrderListRow[]; total: number }> {
  const rows = await db`
    select ${db([...LIST_COLS])} from orders
    ${buildWhere(db, q)}
     order by created_at desc, id desc
     limit ${q.size} offset ${(q.page - 1) * q.size}
  `;
  const counts = await db`
    select count(*)::int as n from orders ${buildWhere(db, q)}
  `;
  return { items: rows.map(toListRow), total: Number(counts[0]?.n ?? 0) };
}

/** 详情主行；不存在 → null（路由层据此 40400）。 */
export async function findAdminOrder(db: Db, orderId: string): Promise<AdminOrderRow | null> {
  const rows = await db`
    select id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
           weight_g, fx_snapshot, address_snapshot, contact_email, terms_version,
           charge_currency, charge_amount, carrier, tracking_no, has_dispute, is_test,
           expires_at, paid_at, shipped_at, created_at, updated_at
      from orders where id = ${orderId}
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: String(r.id),
    order_no: String(r.order_no),
    user_id: String(r.user_id),
    status: String(r.status),
    items_jpy: Number(r.items_jpy),
    shipping_jpy: Number(r.shipping_jpy),
    duty_jpy: Number(r.duty_jpy),
    total_jpy: Number(r.total_jpy),
    weight_g: Number(r.weight_g),
    fx_snapshot: r.fx_snapshot,
    address_snapshot: r.address_snapshot,
    contact_email: strOrNull(r.contact_email),
    terms_version: String(r.terms_version),
    charge_currency: strOrNull(r.charge_currency),
    charge_amount: numOrNull(r.charge_amount),
    carrier: strOrNull(r.carrier),
    tracking_no: strOrNull(r.tracking_no),
    has_dispute: bool(r.has_dispute),
    is_test: bool(r.is_test),
    expires_at: r.expires_at as Date,
    paid_at: (r.paid_at as Date | null) ?? null,
    shipped_at: (r.shipped_at as Date | null) ?? null,
    created_at: r.created_at as Date,
    updated_at: r.updated_at as Date,
  };
}

export async function listOrderItemsFor(
  db: Db,
  orderIds: readonly string[],
): Promise<AdminOrderItemRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await db`
    select order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd
      from order_items where order_id in ${db([...orderIds])}
     order by order_id, id
  `;
  return rows.map((r) => ({
    order_id: String(r.order_id),
    product_id: String(r.product_id),
    title_snapshot: String(r.title_snapshot),
    qty: Number(r.qty),
    unit_price_jpy: Number(r.unit_price_jpy),
    weight_g: Number(r.weight_g),
    declared_value_usd: Number(r.declared_value_usd),
  }));
}

export async function listPaymentsFor(
  db: Db,
  orderIds: readonly string[],
): Promise<AdminPaymentRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await db`
    select order_id, provider, provider_ref, transaction_id, status, charge_currency,
           charge_amount, paid_amount, paid_currency, settled_jpy, fee_jpy, created_at
      from payments where order_id in ${db([...orderIds])}
     order by order_id, created_at
  `;
  return rows.map((r) => ({
    order_id: String(r.order_id),
    provider: String(r.provider),
    provider_ref: strOrNull(r.provider_ref),
    transaction_id: strOrNull(r.transaction_id),
    status: String(r.status),
    charge_currency: String(r.charge_currency),
    charge_amount: Number(r.charge_amount),
    paid_amount: numOrNull(r.paid_amount),
    paid_currency: strOrNull(r.paid_currency),
    settled_jpy: numOrNull(r.settled_jpy),
    fee_jpy: numOrNull(r.fee_jpy),
    created_at: r.created_at as Date,
  }));
}

export async function listEventsFor(
  db: Db,
  orderIds: readonly string[],
): Promise<AdminOrderEventRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await db`
    select order_id, status, note, actor, at
      from order_events where order_id in ${db([...orderIds])}
     order by order_id, at, id
  `;
  return rows.map((r) => ({
    order_id: String(r.order_id),
    status: String(r.status),
    note: strOrNull(r.note),
    actor: strOrNull(r.actor),
    at: r.at as Date,
  }));
}
