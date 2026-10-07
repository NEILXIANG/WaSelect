/**
 * 职责：管理端订单的**读与写**仓储（I2 U-B1 读 / U-B2b 写）——列表（状态 / 关键字 / 分页）、
 *      详情主行、items / payments / events 的批量查询，以及发货 / 退款 / 改址三条写路径。
 *
 * @why **写也放在本文件**（不另开 `orders-admin-write.ts`）：文件头那条"没有 user_id 过滤"
 *      是**管理端 SQL 的固有属性**，读与写同样成立；拆开反而要把它在两份文件里各论证一遍。
 *      读与写在文件内用分隔注释切开，顺序是"先读后写"（写的每一步都要先读到行）。
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
 * @limitation 五：三条写路径都要求调用方**先持行锁**（`lockAdminOrder` 的 FOR UPDATE），
 *              UPDATE 的 WHERE 里再带一次状态条件（与 `markOrderCancelled` 同构）：
 *              前者挡并发，后者挡"锁是上一次读的、状态已被别人迁走"的 TOCTOU。
 *              两条都在时，"0 行命中"只可能表示"状态确实不是我能迁的那一态"。
 * @limitation 六：**不动 `shipments` 表**。契约的 ship 只给 carrier / tracking_no，
 *              而 `shipments` 的价值在 `events`（承运商轨迹）——MVP 没有承运商 API，
 *              落一行进去只会得到 `events: []` 与主表重复的 carrier/tracking_no。
 *              等接入物流轨迹查询时再落，那时它才有区别于 orders 两列的内容。
 *
 * @see contracts/api-contract.yaml（AdminOrderListItem / AdminOrder）；
 *      migrations/001_init.sql（orders / order_items / payments / order_events）；
 *      domain/admin-order-actions.ts（三条写路径的准入判定）；app/admin-order-routes.ts（唯一调用方）
 */
import type { Db, JSONValue } from './db.js';

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
  /** 有迟到付款凭据（`late_paid` 事件，剩余清单 1-5）：已关单也可退款。 */
  late_paid: boolean;
  created_at: Date;
  /**
   * 收件人（地址快照里的 recipient；0.6.9 / KD-14）。
   * @why 列表支持"按收件人搜"，前端列表也有"收件人"列，但原来列表行不带它——
   *      搜到的行收件人一栏是空的，运营无法确认"搜中的是不是这个人"。只带姓名一列：
   *      电话/街道等其余地址字段仍只在详情（最小暴露）。
   */
  recipient: string | null;
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
  /** null = 关税无法估算（W-05 / 迁移 026），不是 0。 */
  duty_jpy: number | null;
  total_jpy: number;
  weight_g: number;
  fx_snapshot: unknown;
  address_snapshot: unknown;
  contact_email: string | null;
  terms_version: string;
  /**
   * ⚠️ `orders.charge_*` **从未被写入**（恒为 null）：扣款币种 / 金额的唯一真源是 `payments` 行
   * （pay-intent 只写 payments）。技术文档曾写"支付时写入 orders.charge_*"——一致性审计 D7（AJ-176）
   * 裁定以 payments 为准、文档标注该两列废弃；这里保留读取只为不改查询形状，**任何新代码不得读它们**。
   */
  charge_currency: string | null;
  charge_amount: number | null;
  carrier: string | null;
  tracking_no: string | null;
  has_dispute: boolean;
  is_test: boolean;
  /** 同 AdminOrderListRow.late_paid。 */
  late_paid: boolean;
  expires_at: Date;
  paid_at: Date | null;
  shipped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 管理端读出的 `order_items` 一行。
 *
 * @why 后三列是**采购快照**（迁移 021 / D-39），只在管理端读出：
 *      采购来源与 JAN 码是**内部信息**，🈲 不得进任何买家可见的响应
 *      （泄露采购渠道等于泄露成本结构与供应链）。
 *      买家侧那两条读路径（`adapters/orders.ts` 的 `listOrderItemsWithImage` 等）
 *      因此**刻意不 select 这三列**——不是忘了，是外泄面要在最窄的那一层收口。
 * @why 类型为 `string | null`：`products` 上这三列可空（商品未填 / 没有 JAN 码），
 *      且迁移之前的历史订单行是 NULL。null = "没记录"，由展示层决定降级文案。
 */
export interface AdminOrderItemRow {
  order_id: string;
  product_id: string;
  title_snapshot: string;
  qty: number;
  unit_price_jpy: number;
  weight_g: number;
  declared_value_usd: number;
  title_ja: string | null;
  jan_code: string | null;
  purchase_source: string | null;
  /** 迁移 027 快照：成本价（内部）/ HS 码 / 英文报关品名；历史行为 NULL。 */
  cost_jpy: number | null;
  hs_code: string | null;
  customs_desc_en: string | null;
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
    late_paid: bool(r.late_paid),
    created_at: r.created_at as Date,
    recipient: strOrNull(r.recipient),
  };
}

/** 分页列表 + 总数（两条 SQL 共用 buildWhere）。 */
export async function listAdminOrders(
  db: Db,
  q: AdminOrderListQuery,
): Promise<{ items: AdminOrderListRow[]; total: number }> {
  const rows = await db`
    select ${db([...LIST_COLS])}, address_snapshot ->> 'recipient' as recipient,
           exists (select 1 from order_events e
                    where e.order_id = orders.id and e.status = 'late_paid') as late_paid
      from orders
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
           expires_at, paid_at, shipped_at, created_at, updated_at,
           exists (select 1 from order_events e
                    where e.order_id = orders.id and e.status = 'late_paid') as late_paid
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
    duty_jpy: r.duty_jpy === null ? null : Number(r.duty_jpy),
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
    late_paid: bool(r.late_paid),
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
    select order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd,
           title_ja, jan_code, purchase_source, cost_jpy, hs_code, customs_desc_en
      from order_items where order_id in ${db([...orderIds])}
     order by order_id, line_no nulls last, id
  `;
  return rows.map((r) => ({
    order_id: String(r.order_id),
    product_id: String(r.product_id),
    title_snapshot: String(r.title_snapshot),
    qty: Number(r.qty),
    unit_price_jpy: Number(r.unit_price_jpy),
    weight_g: Number(r.weight_g),
    declared_value_usd: Number(r.declared_value_usd),
    title_ja: strOrNull(r.title_ja),
    jan_code: strOrNull(r.jan_code),
    purchase_source: strOrNull(r.purchase_source),
    cost_jpy: r.cost_jpy === null ? null : Number(r.cost_jpy),
    hs_code: strOrNull(r.hs_code),
    customs_desc_en: strOrNull(r.customs_desc_en),
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

// ── 写路径（I2 U-B2b：发货 / 退款 / 改址）──────────────────────────────────

/** 持行锁读出的最小判定集（准入判定只需要这些列，多读一列就多一个"忘了它也会变"的隐患）。 */
export interface AdminOrderLockRow {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  total_jpy: number;
  has_dispute: boolean;
  /** 审核期测试单（发货闸门要它，AJ-179）。 */
  is_test: boolean;
  carrier: string | null;
  tracking_no: string | null;
}

/**
 * 持行锁读一张订单（写路径的第一步）。
 * @returns 不存在 → null（路由层 40400）。
 * @why `for update` 而不是"先查后改"：三个写操作都是"读状态 → 判定 → 改状态"，
 *      中间若被别人（支付回调 / 关单 job / 另一个客服）抢先迁移，判定就建立在过期事实上。
 *      行锁把这段窗口焊死——代价是写路径必须包在事务里（事务外 `for update` 等于没锁）。
 */
export async function lockAdminOrder(tx: Db, orderId: string): Promise<AdminOrderLockRow | null> {
  const rows = await tx`
    select id, order_no, user_id, status, total_jpy, has_dispute, is_test, carrier, tracking_no
      from orders where id = ${orderId} for update
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: String(r.id),
    order_no: String(r.order_no),
    user_id: String(r.user_id),
    status: String(r.status),
    total_jpy: Number(r.total_jpy),
    has_dispute: bool(r.has_dispute),
    is_test: bool(r.is_test),
    carrier: strOrNull(r.carrier),
    tracking_no: strOrNull(r.tracking_no),
  };
}

/** 可退款的支付行（**原币**退款的金额与通道来源）。 */
export interface RefundablePaymentRow {
  id: string;
  provider: string;
  provider_ref: string | null;
  charge_currency: string;
  charge_amount: number;
}

/**
 * 取订单最新一条**已成功**的支付行。
 * @returns 没有 succeeded 行 → null（路由层 40902：没付过的钱无从退起）。
 * @why 按 `created_at desc` 取一：一次成功 + 一次失败的行可能并存，
 *      "这笔钱现在在哪"只由最新那条回答。
 */
/**
 * 订单上有没有迟到付款凭据（`late_paid` 事件，见 app/mark-paid.ts `recordLatePaid`）。
 * @see 剩余清单 1-5 / AJ-368
 */
export async function hasLatePaid(db: Db, orderId: string): Promise<boolean> {
  const rows = await db`
    select 1 from order_events where order_id = ${orderId} and status = 'late_paid' limit 1
  `;
  return rows.length > 0;
}

/**
 * 迟到付款要退的那一笔支付行：凭据里的机构单号与支付行**精确对上**的优先，否则取同通道最新一行。
 *
 * @why 迟到的钱没有封口支付行（status 仍是 initiated / cancelled），`findRefundablePayment`
 *      按 succeeded 找不到它；这里按凭据去找。
 * @why 回退到"同通道最新一行"：凭据单号可能是 pi_ 族（payment_intent.succeeded 先到），
 *      而支付行登记的是 cs_ 会话号——两者对不上不代表不是这一笔（同 mark-paid `sameRefFamily` 的 @limitation）。
 * @limitation 换过通道又付了旧会话的极端形态，回退可能选中错误的那一行 → 机构侧拒退（会话无 PI）→
 *             订单停在 refunding，由每日对账 stuck_refunds 报出后人工处理。不会多退钱。
 */
export async function findLatePaidPayment(
  db: Db,
  orderId: string,
): Promise<RefundablePaymentRow | null> {
  const rows = await db`
    select p.id, p.provider, p.provider_ref, p.charge_currency, p.charge_amount
      from payments p
      join order_events e
        on e.order_id = p.order_id and e.status = 'late_paid'
       and e.actor = 'provider:' || p.provider
     where p.order_id = ${orderId} and p.provider_ref is not null
     order by (p.provider_ref = e.note or p.transaction_id = e.note) desc nulls last,
              e.id asc, p.created_at desc
     limit 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: String(r.id),
    provider: String(r.provider),
    provider_ref: strOrNull(r.provider_ref),
    charge_currency: String(r.charge_currency),
    charge_amount: Number(r.charge_amount),
  };
}

export async function findRefundablePayment(
  db: Db,
  orderId: string,
): Promise<RefundablePaymentRow | null> {
  const rows = await db`
    select id, provider, provider_ref, charge_currency, charge_amount
      from payments where order_id = ${orderId} and status = 'succeeded'
     order by created_at desc
     limit 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    id: String(r.id),
    provider: String(r.provider),
    provider_ref: strOrNull(r.provider_ref),
    charge_currency: String(r.charge_currency),
    charge_amount: Number(r.charge_amount),
  };
}

/**
 * 迁 `paid → shipped` 并记事件（同一事务；准入由调用方持锁后判定）。
 * @returns false = 状态已被抢先迁走（**不是错误**）。
 */
export async function markShipped(
  tx: Db,
  orderId: string,
  carrier: string,
  trackingNo: string,
  at: Date,
  /** `admin:<sub>`（技术文档 order_events.actor 口径；admin_audit 未落地前这是"谁发的货"的唯一留痕）。 */
  actor: string,
): Promise<boolean> {
  const updated = await tx`
    update orders set status = 'shipped', carrier = ${carrier}, tracking_no = ${trackingNo},
                      shipped_at = ${at}, updated_at = now()
     where id = ${orderId} and status = 'paid'
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'shipped', ${`${carrier} / ${trackingNo}`}, ${actor}, ${at})
  `;
  return true;
}

/**
 * 记一条**退款失败**事件（不迁状态：订单停在 refunding，可重试，KD-4）。
 *
 * @why 技术文档 refunding 行的原意（"退款失败：停留 refunding + order_events 记 refund_failed"）；
 *      曾经只打运行日志——运营在管理端订单详情里看不到"这张单的退款失败过、何时失败"。
 *      一致性审计 C13（AJ-176）：买家时间线已按订单状态值过滤（listOrderTimeline），
 *      非状态事件不会再以"状态未知"外泄给买家，这一行只进管理端。
 * @why 事务外单条插入：机构调用本就在事务外（第二段），失败时没有可以依附的事务；
 *      插入失败不影响原错误的抛出（调用方 best-effort）。
 * @limitation note 只写**分类**，不写机构错误原文——原文可能含 PII 或机构内部信息，只进运行日志（已脱敏）。
 *             两类分类语义不同（F-03，AJ-178），`findRefundProgress` 靠前缀区分：
 *             · `provider_error`：结果**未知**（超时 / 响应丢失 / 机构报错）→ 重试必须沿用同一幂等键（KD-4）；
 *             · `provider_failed:<机构退款号>`：机构**确认**这笔失败 → 下一次重试换新键重新发起。
 */
export async function recordRefundFailed(
  db: Db,
  orderId: string,
  kind: 'provider_error' | `provider_failed:${string}`,
  actor: string,
  at: Date,
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refund_failed', ${kind}, ${actor}, ${at})
  `;
}

/**
 * 记一条**退款在途**事件（机构回了 pending，F-03 / AJ-178）：note = 机构退款单号。
 * @why 原先 pending 只打一条 info 日志，单号哪儿都没留——之后既查不了机构、也对不上账。
 *      落进 order_events：管理端时间线看得见，`findRefundProgress` 取得回来（买家时间线按状态值过滤，不外泄）。
 */
export async function recordRefundPending(
  db: Db,
  orderId: string,
  refundRef: string,
  actor: string,
  at: Date,
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refund_pending', ${refundRef}, ${actor}, ${at})
  `;
}

/** 退款进度（`findRefundProgress` 的返回）。 */
export interface RefundProgress {
  /** 最新一条退款进度事件是 `refund_pending` 时 = 它的机构单号（下一步是**查询**，不是再 POST）。 */
  pendingRef: string | null;
  /**
   * 机构**确认**失败的次数（`provider_failed:*`）= 下一次发起用的 attempt（换新幂等键）。
   * ⚠️ 按**不同单号**去重（OPS3-06）：同一把键被并发写两条事件只算一次。
   */
  confirmedFailures: number;
}

/**
 * 读退款进度：决定管理员再点"退款"时该**查询**旧单还是**发起**新单、用第几把幂等键（F-03，AJ-178）。
 * @why "最新"按插入顺序（`id desc`）而不是 `at`：同一次请求里先后写入的两条事件 `at` 可以相同
 *      （注入时钟），而"哪条后发生"在我们系统里就是插入顺序。
 * @limitation 只看 `refund_pending` / `refund_failed` 两类；refunding 在一张订单上只会进入一次
 *             （refunded 是终态），所以不必按"本轮退款"切片。
 */
export async function findRefundProgress(db: Db, orderId: string): Promise<RefundProgress> {
  const rows = await db<{ status: string; note: string | null }[]>`
    select status, note from order_events
     where order_id = ${orderId} and status in ('refund_pending', 'refund_failed')
     order by id desc
  `;
  const latest = rows[0];
  return {
    pendingRef:
      latest?.status === 'refund_pending' && typeof latest.note === 'string' && latest.note !== ''
        ? latest.note
        : null,
    // ⚠️ 按**不同单号**去重，不是按事件行数计（OPS3-06）：
    //    同一把幂等键（re_1）的失败被两个并发请求各写一条事件时，行数 = 2，
    //    而"这把键已经确认失败过几次"只该是 1。多算一次的直接后果是**下一次换一把新幂等键**
    //    （`attempt = confirmedFailures + 1`），而 KD-4 要求"结果未知"时**沿用同一把键**——
    //    换键的代价取决于通道侧有没有额度校验：Stripe 会以"超过可退金额"拒（订单停在 refunding 等人工），
    //    别的通道则没有这层保护。去重后，两个请求都失败也只是"这把键失败了 1 次"。
    confirmedFailures: new Set(
      rows
        .filter((r) => r.status === 'refund_failed' && (r.note ?? '').startsWith('provider_failed'))
        .map((r) => r.note ?? ''),
    ).size,
  };
}

/**
 * 迁 `paid|shipped|delivered → refunding` 并记事件。
 * @why **先落 refunding 再调机构**（顺序不能倒）：反过来（先调机构、成功后才迁状态）的
 *      失败模式是"钱已退、我们的库还写着 paid"——客服看到 paid 会再退一次，
 *      而机构侧那笔钱已经出去了，于是**同一笔钱退两次**且我方没有记录。
 *      先落 refunding 的代价是"机构调用失败时订单停在 refunding"，
 *      而那是一个**看得见**的状态（有事件、列表能筛），比"钱货对不上但没人知道"轻得多。
 */
export async function markRefunding(
  tx: Db,
  orderId: string,
  reason: string,
  at: Date,
  /** `admin:<sub>`（同 markShipped）。 */
  actor: string,
): Promise<boolean> {
  // expired / cancelled 只在有迟到付款凭据时可迁（剩余清单 1-5）：与 refundGuard 同口径，
  //    这里再写一次是 SQL 层的最后一道——闸门之外的调用方也绕不过去
  const updated = await tx`
    update orders set status = 'refunding', updated_at = now()
     where id = ${orderId}
       and (status in ${tx(['paid', 'shipped', 'delivered'])}
            or (status in ${tx(['expired', 'cancelled'])}
                and exists (select 1 from order_events
                             where order_id = ${orderId} and status = 'late_paid')))
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refunding', ${reason}, ${actor}, ${at})
  `;
  return true;
}

/**
 * **人工解除**订单的拒付限制（`orders.has_dispute` true → false）并记事件（B1b / AJ-194）。
 *
 * @why 这个写操作是 A4 / B33 / B1a 之后**所有**"订单被永久锁死"情形的唯一出口：
 *      结案事件没到（机构漏发 / 我们当时没接住）、未知状态被拒落库、
 *      败诉单后来与买家协商好了、甚至只是某次回调丢了一——它们共同的终点都是
 *      "has_dispute 是 true 且再也不会变"。没有这个口，唯一的解法是**直连数据库改行**，
 *      那既不留痕也不可复核。
 * @why 条件是 `has_dispute = true` 而不是无条件更新：命中 0 行时调用方转 40902
 *      `dispute_not_locking`。@why "解除一个本来就没锁的限制"如果返回成功，
 *      运营点错单号时会**以为自己解开了某张单**，而实际上什么都没发生——
 *      这类"静默成功"正是逃生口最危险的用法。
 *
 * @limitation **不动 `payments.dispute_*`**：解除的是"限制"，不是"事实"。
 *              拒付发生过、输过、赢过，这些都留在支付行上，风控列表照样看得到；
 *              改它们等于让人能**抹掉**拒付记录，那不是逃生口而是橡皮擦。
 * @limitation 事件名 `dispute_released` 与开案 / 结案的 `dispute_opened` / `dispute_closed`
 *              并列：订单时间线上要能看出"限制是什么时候、被谁解开的"。
 *              ⚠️ 它是**人工**动作（actor 是 `admin:<sub>`），与机构事件天然可区分。
 *
 * @see app/admin-order-routes.ts（唯一调用方）；domain/admin-order-actions.ts（releaseReasonGuard）
 */
export async function releaseDisputeHold(
  tx: Db,
  orderId: string,
  reason: string,
  at: Date,
  actor: string,
): Promise<boolean> {
  const updated = await tx`
    update orders set has_dispute = false, updated_at = now()
     where id = ${orderId} and has_dispute = true
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'dispute_released', ${reason}, ${actor}, ${at})
  `;
  return true;
}

/**
 * 最近一次进入 refunding 时记下的退款理由（重试沿用它，KD-4）。
 * @why 机构退款请求里带着理由（Stripe `metadata[reason]`），而机构侧幂等键按订单固定
 *      （`refund:<orderId>`）——重试时换一句理由就是"同键异参"，Stripe 会 400。
 *      所以重试必须发**首次**的理由，而首次理由唯一的落点就是这条事件的 note。
 * @returns null = 没有 refunding 事件（数据不一致，调用方应响亮失败）。
 */
export async function findRefundingReason(tx: Db, orderId: string): Promise<string | null> {
  const rows = await tx`
    select note from order_events
     where order_id = ${orderId} and status = 'refunding'
     order by at desc, id desc
     limit 1
  `;
  const note = rows[0]?.['note'];
  return typeof note === 'string' && note !== '' ? note : null;
}

/**
 * 迁 `refunding → refunded`，把 payment 行标成 refunded，事件里留机构退款号。
 * @returns false = 当前不是 refunding（重复提交 / 已被别处迁走，**不是错误**）。
 * @limitation `payments.status` 目前是**约定词表**（initiated / succeeded / cancelled /
 *      failed / refunded），shared 里没有对应枚举——加新词没有任何编译期或门禁守护。
 *      这是已知缺口（F12 售后对账统一收口时补枚举 + 与契约双向比对）。
 */
export async function markRefunded(
  tx: Db,
  orderId: string,
  paymentId: string,
  refundRef: string,
  at: Date,
  /** `admin:<sub>`（同 markShipped）。 */
  actor: string,
): Promise<boolean> {
  const updated = await tx`
    update orders set status = 'refunded', refunded_at = ${at}, updated_at = now()
     where id = ${orderId} and status = 'refunding'
  `;
  if (updated.count === 0) return false;
  await tx`
    update payments set status = 'refunded' where id = ${paymentId}
  `;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refunded', ${refundRef}, ${actor}, ${at})
  `;
  return true;
}

/**
 * 改址：重写 `address_snapshot` 并记事件（**不改状态**）。
 * @returns false = 当前不是 paid（已被抢先发货 / 退款，**不是错误**）。
 * @why 事件用伪状态 `address_changed` 而不是复用 `paid`：时间线里两条都叫 paid 的话，
 *      "这笔单付过几次款"就成了猜谜。**买家**时间线（`listOrderTimeline`）按 ORDER_STATUS
 *      过滤，看不到它（一致性审计 C2，AJ-176——此前买家端小程序会把它渲染成"状态未知"）。
 *      ⚠️ 2026-10-02 更正（ADR-29：注释与事实不符即 bug）：本处原写"**管理端**详情页直接
 *      显示 `status` 原文，所以不会被渲染成'未知状态'"——L4 浏览器验收发现那句话正是缺陷
 *      本身（管理端详情页显示 `paid` 而列表页显示「待发货」，同一个状态两种叫法）。
 *      现管理端走 `admin-web/src/orders/view.ts` 的 `eventStatusText`：
 *      订单状态翻中文，伪状态查 `EVENT_STATUS_LABELS`（`address_changed` → 改址），
 *      查不到才原样显示。⚠️ 新增伪状态或改文案时，要同步改那份词表。
 *      @limitation 它不在 `ORDER_STATUS` 枚举里——`order_events.status` 是 VARCHAR 故不违反
 *      DB 约束，但任何"按 enum 校验事件状态"的将来逻辑都要把它列为例外。
 * @why 事件的 note 存**改前地址的完整 JSON**（`{"from": …}`，B12 / AJ-208），不是固定文案：
 *      盗号后联系客服改址、或买家事后以"未收到货"拒付时，必须答得出
 *      "原地址是什么、何时被谁改成了什么"——改址恰恰是这类欺诈的典型手法，
 *      而 `address_snapshot` 被整体覆盖之后，旧地址在全库**再无第二处**。
 * @why 存 `order_events` 而不是 `admin_audit`：前者与 `orders` 同级、本就存着这份 PII
 *      （收货信息是订单的一部分），约束七禁的是"PII 进**日志**"，不是进订单事件；
 *      后者是全库 PII 的**第二份**聚集地，不该再复制一份（AJ-207 的同一条理由）。
 *      ⚠️ 这里**曾经**还写着"后者 append-only 无法删除"作为选前者的理由之一——
 *      那是错的（DB3-03）：`order_events` 同样挂着 `trg_order_events_append_only`
 *      （`migrations/002_hardening.sql`），UPDATE / DELETE 一律 42501 拒绝。
 *      两处都删不掉，这条理由不成立；真正剩下的理由只有"与订单同级、便于应诉检索"。
 *      ✅ **2026-10-01 已落地（AJ-293）**：旧快照改存 `order_address_history`（019 迁移，
 *      刻意**不挂** append-only），`order_events.note` 只留一句人话 + 归档号。
 *      取证链一步不变（按号查回完整旧地址），但这部分 PII 从此**可匿名化 / 可删除**——
 *      这是 AJ-292 定的匿名化出口唯一被堵住的那一处。
 *      @limitation **存量仍然删不掉**：019 之前写进 `order_events.note` 的旧地址
 *      （形态是 `{"from":{...}}` 全文）改不了也删不掉——表能改，历史行改不了。
 *      读取侧要同时认得两种形态：旧行读 note 里的 `from`，新行按 `from_id` / 归档号查历史表。
 *      @limitation **仍不**为删除请求临时摘触发器：一次临时摘除 = 这条防线在谁的机器上失效过就说不清了（AJ-272）。
 *      @limitation note 是 TEXT，管理端详情页按原文渲染。改格式**顺带**修掉了一个既有暴露面：
 *      此前 `{"from":{...}}` 整段 JSON 直接显示 ⇒ **所有能看到订单详情的运营都能看到改前完整地址明文**；
 *      现在只显示"改址：改前地址已归档（#N）"，PII 从"人人可见"收回"需要时按号查库"。
 */
export async function updateAddressSnapshot(
  tx: Db,
  orderId: string,
  snapshot: JSONValue,
  actor: string,
  at: Date,
): Promise<boolean> {
  // B12 / AJ-208：先把**旧快照**读出来——它是"改址前发给谁"的唯一证据。
  // `for update` 是为了让本函数自洽（不依赖调用方是否先调过 lockAdminOrder）：
  // UPDATE 也会取同一把行锁，这里提前取只是把"读旧值"与"写新值"之间的窗口彻底关掉。
  const before = await tx`select address_snapshot from orders where id = ${orderId} for update`;
  const previous = before[0]?.['address_snapshot'] ?? null;
  const updated = await tx`
    update orders set address_snapshot = ${tx.json(snapshot)}, updated_at = now()
     where id = ${orderId} and status = 'paid'
  `;
  if (updated.count === 0) return false;
  /**
   * AJ-293：旧快照**先**归档到 `order_address_history`（019，刻意不挂 append-only），
   * 再把**归档号**写进 note——note 所在的 `order_events` 删不掉，旧地址一旦进去就永久锁死。
   *
   * @why 顺序不能反：先插历史表拿到 id，再写 note。反过来（先写 note）会在两步之间
   *      留下"note 说了有归档、但历史表里没有"的窗口，而取证链断掉是**静默**的。
   * @why `previous` 不为 null 这件事由库保证（`orders.address_snapshot` 是 NOT NULL 列，
   *      且本函数已 `for update` 锁行）。若哪天这个假设被打破，插入会因 NOT NULL 违反而抛错、
   *      整条改址事务回滚——**不会**静默丢掉取证链，所以这里不为 null 写分支
   *      （不可达分支写了也拿不到红灯，AJ-256 / AJ-291 的同一条纪律）。
   */
  const archived = await tx`
    insert into order_address_history (order_id, snapshot, actor, at)
    values (${orderId}, ${tx.json(previous as JSONValue)}, ${actor}, ${at})
    returning id
  `;
  const archiveId = archived[0]?.['id'];
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'address_changed', ${`改址：改前地址已归档（#${String(archiveId)}）`}, ${actor}, ${at})
  `;
  return true;
}
