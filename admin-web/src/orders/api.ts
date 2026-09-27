/**
 * 职责：订单管理的**接口层**——路径、请求体、响应形状收口（与 `products/api.ts` 同构）。
 *
 * @why 形状校验集中在这里：服务端改了形状时**在这里**硬失败，
 *      而不是让 undefined 流进表格变成"整列空白但不报错"——
 *      订单列表空一格，客服会以为"这单没有金额"。
 *
 * @limitation 一：**不吞形状错误**——200 但形状不符按网络层异常抛（NETWORK_ERROR_CODE），
 *              与 `products/api.ts` @limitation 一 同口径。
 * @limitation 二：这三个写接口（发货 / 退款 / 改址）契约**没有声明 Idempotency-Key**
 *              （与 `POST /orders` / `POST /orders/{id}/pay` 不同），所以前端**不传**。
 *              防重复提交的兜底是服务端状态机（已发货不能再发货、refunding 期间不能退款）
 *              + 前端按钮禁用；⚠️ 这不是幂等，只是"第二次大概率被拒"——
 *              将来契约补上幂等头时，这里要跟着传（否则超时重发真的会发两次货）。
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
import type { OrderStatus } from '@waselect/shared';

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
  carrier?: string;
  tracking_no?: string;
  has_dispute?: boolean;
  is_test?: boolean;
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
  status?: OrderStatus;
  keyword?: string;
  page?: number;
  size?: number;
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
  if (query.status !== undefined) params.set('status', query.status);
  if (query.keyword !== undefined && query.keyword !== '') params.set('keyword', query.keyword);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.size !== undefined) params.set('size', String(query.size));
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

/** `POST /admin/orders/{id}/ship`（发货；已发货 → 服务端 409）。 */
export async function shipOrder(
  api: AdminApi,
  id: string,
  body: { carrier: string; tracking_no: string },
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/ship`,
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/**
 * `POST /admin/orders/{id}/refund`（全额退款；原币退）。
 * @why 返回值是 202 且不读响应体：契约没给退款响应结构，
 *      "看起来成功了"这件事由服务端的状态机（refunding → refunded）表达，
 *      前端要确认结果就再拉一次详情——凭空假设一个 `{refund_id}` 只会造出永不兑现的字段。
 */
export async function refundOrder(
  api: AdminApi,
  id: string,
  body: { reason: string },
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/orders/${encodeURIComponent(id)}/refund`,
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
