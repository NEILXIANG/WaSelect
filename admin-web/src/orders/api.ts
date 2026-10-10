/**
 * 职责：订单管理的**接口层**——路径、请求体、响应形状收口（与 `products/api.ts` 同构）。
 *
 * @why 形状校验集中在这里：服务端改了形状时**在这里**硬失败，
 *      而不是让 undefined 流进表格变成"整列空白但不报错"——
 *      订单列表空一格，客服会以为"这单没有金额"。
 *
 * @limitation 一：**不吞形状错误**——200 但形状不符按网络层异常抛（NETWORK_ERROR_CODE），
 *              与 `products/api.ts` @limitation 一 同口径。
 * @limitation 二：这四个写接口（发货 / 退款 / 改址 / **解除拒付限制**）契约**没有声明
 *              Idempotency-Key**（与 `POST /orders` / `POST /orders/{id}/pay` 不同），所以前端**不传**。
 *              防重复提交的兜底是服务端状态机（已发货不能再发货、refunding 期间不能退款、
 *              已没锁的单解除会 40902 `dispute_not_locking`）+ 前端按钮禁用；
 *              ⚠️ 这不是幂等，只是"第二次大概率被拒"——
 *              将来契约补上幂等头时，这里要跟着传（否则超时重发真的会发两次货）。
 *              ⚠️ 解除那一条**尤其**不幂等：契约没有"重新上锁"的接口，
 *              解开了就收不回，所以前端用两步确认 + 按钮在提交期间禁用兜底。
 * @limitation 三：列表接口返回的是 **`AdminOrderListItem`**（契约 0.6.1 起，不再是 `Order`）：
 *              带 `has_dispute` / `is_test`，但**不带** `items` / `address` / `timeline` /
 *              `payments` / `events`——那些只有详情接口 `AdminOrder` 才有。
 *              ⚠️ 0.6.1 之前列表被声明成 `Order`（不含 has_dispute），前端因此写过
 *              "列表查不出拒付"的兜底（@see ../orders/view.ts @limitation 二 的历史版本）。
 *              现在字段在，但 `refundGate` 对"字段缺失"**仍**放行——那是防御，
 *              不是"预期会有缺失"：契约形状再变一次时，不至于让正常单点不动。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/orders*）；./view.ts（请求体的生产者）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import type { OrderAttention, OrderStatus } from '@waselect/shared';
import type { OrderNote } from './notes-view.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `Order` / `AdminOrder` 里本模块真正读的字段（其余透传不校验）。 */
export interface AdminOrderLike {
  order_id: string;
  order_no?: string;
  status?: string;
  total_jpy?: number;
  created_at?: string;
  contact_email?: string;
  user_id?: string;
  /** 客户卡片（契约 0.6.47 / AJ-404）；下单人是管理员或旧服务端时缺省。 */
  customer?: { user_id?: string; order_count?: number; paid_total_jpy?: number; blocked?: boolean };
  carrier?: string;
  tracking_no?: string;
  has_dispute?: boolean;
  is_test?: boolean;
  /** 列表行（契约 0.6.58 / AJ-425）：下单人已被拉黑；详情形状里在 customer.blocked。 */
  user_blocked?: boolean;
  address?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
  payment?: Record<string, unknown>;
  payments?: Array<Record<string, unknown>>;
  events?: Array<{ status?: string; note?: string; actor?: string; at?: string }>;
}

export interface OrderListResp {
  items: AdminOrderLike[];
  total: number;
}

/** 列表查询参数（契约：`status` / `keyword` 可选，`page` / `size` 有默认值）。 */
export interface OrderListQuery {
  /** 一个或多个状态（多个 = 任一命中，契约 0.6.44 逗号分隔；AJ-400 页签用）。空数组 = 不过滤。 */
  status?: OrderStatus | readonly OrderStatus[];
  keyword?: string;
  /** 下单日期（JST 日历日 `YYYY-MM-DD`，两端都含；契约 0.6.44 created_from / created_to）。 */
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  size?: number;
  /** true = 连审核期测试单一起列（契约 0.6.32 include_test，剩余清单 3-4）。 */
  includeTest?: boolean;
  /** 排序（契约 0.6.53：`total_jpy` / `-total_jpy` / `created_at` / `-created_at`；不传 = 下单时间倒序）。 */
  sort?: string;
  /** 待处理筛选（契约 0.6.58 / AJ-425）：售后待处理 / 迟到付款待退 / 拉黑用户的已付单。 */
  attention?: OrderAttention;
}

/**
 * `GET /admin/orders`。
 * @throws {ApiError} 响应形状与契约不符（空列表是 `{items:[],total:0}`，不是"没有 body"）
 */
export async function listOrders(
  api: AdminApi,
  query: OrderListQuery = {},
  traceId?: string,
): Promise<OrderListResp> {
  const params = new URLSearchParams();
  const status = typeof query.status === 'string' ? query.status : query.status?.join(',');
  if (status !== undefined && status !== '') params.set('status', status);
  if (query.createdFrom !== undefined) params.set('created_from', query.createdFrom);
  if (query.createdTo !== undefined) params.set('created_to', query.createdTo);
  if (query.keyword !== undefined && query.keyword !== '') params.set('keyword', query.keyword);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.size !== undefined) params.set('size', String(query.size));
  if (query.includeTest === true) params.set('include_test', 'true');
  if (query.sort !== undefined && query.sort !== '') params.set('sort', query.sort);
  if (query.attention !== undefined) params.set('attention', query.attention);
  const qs = params.toString();
  const resp = await api({
    path: `/api/v1/admin/orders${qs === '' ? '' : `?${qs}`}`,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertOrderList(resp, traceId ?? '');
  return resp;
}

/** `GET /admin/orders/{id}`（详情，返回 AdminOrder：带 has_dispute / payments / events）。 */
export async function getOrder(
  api: AdminApi,
  id: string,
  traceId?: string,
): Promise<AdminOrderLike> {
  const resp = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}`,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertOrder(resp, traceId ?? '');
  return resp;
}

/**
 * `POST /admin/orders/{id}/ship`（发货；已发货 → 服务端 409）。
 * @returns 响应原样（契约 0.6.37 起带 `tracking_recognized`，交给 `fix-view.ts` 的 trackingWarning 转述）
 */
export async function shipOrder(
  api: AdminApi,
  id: string,
  body: { carrier: string; tracking_no: string },
  traceId?: string,
): Promise<unknown> {
  return api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/ship`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** 批量发货的一行结果（契约 0.6.45 `ShipBatchItemResult`）。 */
export interface ShipBatchResult {
  order_id: string;
  ok: boolean;
  code?: number;
  message?: string;
  reason?: string;
  tracking_recognized?: boolean;
}

/**
 * `POST /admin/orders/ship-batch`（AJ-401）——逐单结果，与 items 同序。
 * @throws {ApiError} 整次被拒（400 / 40001：超上限 / 重复单号等）或响应形状不符
 */
/** 批量发货服务端逐单串行（最多 50 单），默认 10s 会先在前端超时而服务端继续发完（审查 2026-10-09 #10）；与导出同一量级。 */
export const SHIP_BATCH_TIMEOUT_MS = 60_000;

export async function shipOrdersBatch(
  api: AdminApi,
  items: readonly { order_id: string; carrier: string; tracking_no: string }[],
): Promise<ShipBatchResult[]> {
  const resp = await api({
    path: '/api/v1/admin/orders/ship-batch',
    method: 'POST',
    body: { items },
    timeoutMs: SHIP_BATCH_TIMEOUT_MS,
  });
  const results = (resp as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    throw new ApiError(NETWORK_ERROR_CODE, '批量发货响应形状与契约不符（缺 results）', '');
  }
  return results as ShipBatchResult[];
}

/**
 * 按**人看的订单号**逐个查订单（CSV 导入用；AJ-401）。
 * @why 复用列表接口的 keyword（含测试单），结果里只认 `order_no` **完全相等**的那一条——
 *      keyword 是模糊匹配，`261007-7K3QXA` 也会命中别单收件人或运单号里恰好含这一串的。
 * @why 每次最多 4 个并发：CSV 至多 50 行（SHIP_BATCH_MAX），串行太慢，全并发会挤占同一个管理员的其它请求。
 * @limitation 不新增"按单号批量查"的接口：50 次小查询换零契约改动；量再大时再加。
 */
export async function findOrdersByNo(
  api: AdminApi,
  orderNos: readonly string[],
): Promise<Map<string, AdminOrderLike>> {
  const found = new Map<string, AdminOrderLike>();
  const queue = [...new Set(orderNos.filter((n) => n !== ''))];
  const worker = async (): Promise<void> => {
    for (let no = queue.shift(); no !== undefined; no = queue.shift()) {
      const res = await listOrders(api, { keyword: no, includeTest: true, size: 20 });
      const hit = res.items.find((o) => o.order_no === no);
      if (hit !== undefined) found.set(no, hit);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return found;
}

/**
 * 退款结果（契约 0.6.11：`202 {order_id, outcome}`）。
 *
 * @why 判别联合而不是 `string`：调用方必须穷举三种——
 *      `succeeded`（钱已退，订单 refunded）、`pending`（机构处理中，订单停在 refunding）、
 *      `unknown`（响应形状认不出）。把它们折成一个布尔会让"处理中"与"失败"同形，
 *      而运营对两者的动作**相反**（等 vs 重试），见 B41 / AJ-215。
 */
export type RefundOutcome = 'succeeded' | 'pending' | 'unknown';

/**
 * `POST /admin/orders/{id}/refund`（全额退款；原币退）。
 *
 * @why **必须读 `outcome`**（B41 / AJ-215）：契约 0.6.11 起 202 带它，
 *      而此前这里返回 `void`、注释写"契约没给响应结构"——于是
 *      `pending`（机构处理中）在界面上**没有任何提示**，运营看到订单停在"退款中"、
 *      提示语又写着"机构调用失败或超时，可重试"，会认定退款失败并转去 Stripe 后台手工退，
 *      正落进 AJ-178 反向风险①（同一笔钱被退两次）。
 * @why 认不出就返回 `unknown` 而不是猜成 `pending`：猜"处理中"会让界面显示
 *      "已提交，等待机构确认"——那是一个**我们并不知道**的事实；
 *      `unknown` 由界面按"结果未知，请刷新详情确认"处理，不编造。
 */
export async function refundOrder(
  api: AdminApi,
  id: string,
  body: { reason: string },
  traceId?: string,
): Promise<RefundOutcome> {
  const res = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/refund`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  const outcome = (res as { outcome?: unknown } | null)?.['outcome'];
  if (outcome === 'succeeded') return 'succeeded';
  if (outcome === 'pending') return 'pending';
  return 'unknown';
}

/**
 * `POST /admin/orders/{id}/dispute/release`——**人工解除拒付限制**（B1b / AJ-194 的逃生口）。
 *
 * @why 这个口的形状必须校验：**成功返回 `has_dispute:false` 是本动作的唯一证据**。
 *      不校验的话，将来服务端改成返回别的形状，页面会拿着 undefined 当"已解除"，
 *      而运营看到的是"点了、没报错、以为解开了"——这条链断掉的样子和退款的
 *      `pending` 当成失败是同一类（@see `refundOrder` @why）。
 * @why `has_dispute` 断言 **false** 而不是"是布尔就行"：契约写死了这个值是 false
 *      （本接口就是把 true 改成 false）。返回 true 说明服务端没做成，
 *      按"已解除"处理会让页面立刻放开发货按钮——那正是钱货两空的入口。
 *
 * @throws {ApiError} 响应形状与契约不符（NETWORK_ERROR_CODE）
 */
export async function releaseDisputeHold(
  api: AdminApi,
  id: string,
  body: { reason: string },
  traceId?: string,
): Promise<{ order_id: string; has_dispute: false }> {
  const res = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/dispute/release`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  const o = res as { order_id?: unknown; has_dispute?: unknown } | null;
  if (typeof o?.['order_id'] !== 'string' || o?.['has_dispute'] !== false) {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      '解除拒付限制的响应形状与契约不符（应为 {order_id, has_dispute:false}）',
      traceId ?? '',
    );
  }
  return { order_id: o['order_id'], has_dispute: false };
}

/** `POST /admin/orders/{id}/cancel`（取消**未付**订单，原因必填；P1-11 / AJ-386）。 */
export async function cancelOrder(
  api: AdminApi,
  id: string,
  body: { reason: string },
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/cancel`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/**
 * `PATCH /admin/orders/{id}/shipment`（改**已发货**订单的承运商 / 运单号，原因必填；P1-10 / AJ-386）。
 * 服务端会按新运单号重发一封发货邮件；响应带 `tracking_recognized`。
 */
export async function fixShipment(
  api: AdminApi,
  id: string,
  body: { carrier: string; tracking_no: string; reason: string },
  traceId?: string,
): Promise<unknown> {
  return api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/shipment`,
    method: 'PATCH',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/**
 * `POST /admin/orders/{id}/shipment/revert`（撤销发货，原因必填；AJ-440）。
 * 订单回到 paid、运单清空，服务端给买家发一封更正邮件。
 */
export async function revertShipment(
  api: AdminApi,
  id: string,
  body: { reason: string },
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/shipment/revert`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** `POST /admin/orders/{id}/address`（发货前改址；请求体是 `AddressInput`）。 */
export async function updateOrderAddress(
  api: AdminApi,
  id: string,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/address`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** 列表响应形状校验（@see @limitation 一）。 */
function assertOrderList(value: unknown, traceId: string): asserts value is OrderListResp {
  const o = value as { items?: unknown; total?: unknown } | null;
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(o?.items) ||
    !o.items.every((x) => typeof (x as { order_id?: unknown } | null)?.order_id === 'string')
  ) {
    throw new ApiError(NETWORK_ERROR_CODE, '订单列表响应形状与契约不符', traceId);
  }
  if (typeof o?.total !== 'number') {
    throw new ApiError(NETWORK_ERROR_CODE, '订单列表缺 total（分页无法判断到底）', traceId);
  }
}

/** 单个订单响应形状校验（缺 order_id 的行点了会打到 `/admin/orders/undefined`）。 */
function assertOrder(value: unknown, traceId: string): asserts value is AdminOrderLike {
  if (typeof (value as { order_id?: unknown } | null)?.order_id !== 'string') {
    throw new ApiError(NETWORK_ERROR_CODE, '订单响应形状与契约不符（缺 order_id）', traceId);
  }
}

/**
 * `POST /admin/orders/{id}/partial-refunds`（AJ-383，契约 0.6.35）——发起一笔部分退款。
 * @param body.amount_minor 支付币种**最小单位**（由 `parseAmountToMinor` 换算，不在这里换）
 * @why 返回整行而不是只回 outcome：页面紧接着要显示这一笔的状态（成功 / 处理中 / 结果未知）。
 */
export async function createPartialRefund(
  api: AdminApi,
  id: string,
  body: { amount_minor: number; reason: string },
): Promise<unknown> {
  const res = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/partial-refunds`,
    method: 'POST',
    body,
  });
  return (res as { refund?: unknown } | null)?.refund ?? null;
}

/** `POST /admin/orders/{id}/partial-refunds/{refundId}/sync`——pending 查询 / 结果未知同键重放。 */
export async function syncPartialRefund(
  api: AdminApi,
  id: string,
  refundId: string,
): Promise<unknown> {
  const res = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/partial-refunds/${encodeURIComponent(refundId)}/sync`,
    method: 'POST',
    body: {},
  });
  return (res as { refund?: unknown } | null)?.refund ?? null;
}

/**
 * `POST /admin/orders/{id}/after-sales/{rid}/resolve`（售后处理，AJ-420，契约 0.6.56）。
 * @why 不校验响应形状：成功后父页整页刷新，以 `GET /admin/orders/{id}` 的 `after_sales` 为准。
 */
export async function resolveAfterSale(
  api: AdminApi,
  id: string,
  rid: string,
  body: { status: 'processing' | 'resolved' | 'rejected'; note?: string },
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/after-sales/${encodeURIComponent(rid)}/resolve`,
    method: 'POST',
    body,
  });
}

/** `OrderNote` 形状校验（契约 0.6.42）：缺 id / body / created_at 的行渲染出来是空气泡。 */
function isOrderNote(x: unknown): x is OrderNote {
  const n = x as Record<string, unknown> | null;
  return (
    typeof n === 'object' &&
    n !== null &&
    typeof n['id'] === 'string' &&
    typeof n['author'] === 'string' &&
    typeof n['body'] === 'string' &&
    typeof n['created_at'] === 'string'
  );
}

/**
 * `GET /admin/orders/{id}/notes`（订单内部备注，第一批⑤，AJ-396）。
 * @throws {ApiError} 响应形状与契约不符（@see 文件头 @limitation 一）
 */
export async function listOrderNotes(api: AdminApi, id: string): Promise<OrderNote[]> {
  const resp = await api({ path: `/api/v1/admin/orders/${encodeURIComponent(id)}/notes` });
  const items = (resp as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.every(isOrderNote)) {
    throw new ApiError(NETWORK_ERROR_CODE, '备注列表响应形状与契约不符', '');
  }
  return items;
}

/** `POST /admin/orders/{id}/notes`（append-only：没有改 / 删接口）。返回新追加的那一条。 */
export async function addOrderNote(api: AdminApi, id: string, body: string): Promise<OrderNote> {
  const resp = await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/notes`,
    method: 'POST',
    body: { body },
  });
  const note = (resp as { note?: unknown } | null)?.note;
  if (!isOrderNote(note)) {
    throw new ApiError(NETWORK_ERROR_CODE, '备注已提交，但响应形状与契约不符：请刷新核对', '');
  }
  return note;
}
