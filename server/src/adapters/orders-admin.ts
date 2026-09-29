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
  duty_jpy: number;
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
    recipient: strOrNull(r.recipient),
  };
}

/** 分页列表 + 总数（两条 SQL 共用 buildWhere）。 */
export async function listAdminOrders(
  db: Db,
  q: AdminOrderListQuery,
): Promise<{ items: AdminOrderListRow[]; total: number }> {
  const rows = await db`
    select ${db([...LIST_COLS])}, address_snapshot ->> 'recipient' as recipient from orders
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

// ── 写路径（I2 U-B2b：发货 / 退款 / 改址）──────────────────────────────────

/** 持行锁读出的最小判定集（准入判定只需要这些列，多读一列就多一个"忘了它也会变"的隐患）。 */
export interface AdminOrderLockRow {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  total_jpy: number;
  has_dispute: boolean;
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
    select id, order_no, user_id, status, total_jpy, has_dispute, carrier, tracking_no
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
 * @limitation note 只写**分类**（provider_error / provider_failed），不写机构错误原文——
 *             原文可能含 PII 或机构内部信息，只进运行日志（已脱敏）。
 */
export async function recordRefundFailed(
  db: Db,
  orderId: string,
  kind: 'provider_error' | 'provider_failed',
  actor: string,
  at: Date,
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refund_failed', ${kind}, ${actor}, ${at})
  `;
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
  const updated = await tx`
    update orders set status = 'refunding', updated_at = now()
     where id = ${orderId} and status in ${tx(['paid', 'shipped', 'delivered'])}
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'refunding', ${reason}, ${actor}, ${at})
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
 *      "这笔单付过几次款"就成了猜谜。**管理端**详情页直接显示 `status` 原文，所以不会被渲染成"未知状态"；
 *      **买家**时间线（`listOrderTimeline`）按 ORDER_STATUS 过滤，看不到它（一致性审计 C2，AJ-176——
 *      此前买家端小程序会把它渲染成"状态未知"，本注释当时只考虑了管理端）。
 *      @limitation 它不在 `ORDER_STATUS` 枚举里——`order_events.status` 是 VARCHAR 故不违反
 *      DB 约束，但任何"按 enum 校验事件状态"的将来逻辑都要把它列为例外。
 */
export async function updateAddressSnapshot(
  tx: Db,
  orderId: string,
  snapshot: JSONValue,
  actor: string,
  at: Date,
): Promise<boolean> {
  const updated = await tx`
    update orders set address_snapshot = ${tx.json(snapshot)}, updated_at = now()
     where id = ${orderId} and status = 'paid'
  `;
  if (updated.count === 0) return false;
  await tx`
    insert into order_events (order_id, status, note, actor, at)
    values (${orderId}, 'address_changed', '管理员改址', ${actor}, ${at})
  `;
  return true;
}
