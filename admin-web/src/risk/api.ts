/**
 * 职责：风控的**接口层**（拒付列表 / 拉黑用户）。
 *
 * @limitation 一：`GET /admin/disputes` 返回**裸数组**（同 `ops/api.ts`），不是 `{items,total}`。
 * @limitation 二：`POST /admin/users/{id}/block` 是**不可逆**的（契约没有解除接口），
 *              所以本层**不做任何重试**（通用封装同样不重试，@see ../api/client.ts @limitation 一）；
 *              超时后必须**先 GET 该用户状态确认**再决定要不要重发，而不是直接重发。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/disputes、/admin/users/{id}/block）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import type { DisputeStatus } from './view.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `Dispute`。 */
export interface DisputeLike {
  order_id?: string;
  order_no?: string;
  payment_id?: string;
  dispute_id?: string;
  dispute_status?: string;
  dispute_amount?: number;
  charge_currency?: string;
  opened_at?: string;
  closed_at?: string;
}

/** `GET /admin/disputes`（status 为空 = 不过滤）。 */
export async function listDisputes(
  api: AdminApi,
  status?: DisputeStatus,
  traceId?: string,
): Promise<DisputeLike[]> {
  const qs = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;
  const resp = await api({
    path: `/api/v1/admin/disputes${qs}`,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  if (!Array.isArray(resp)) {
    throw new ApiError(NETWORK_ERROR_CODE, '拒付列表响应形状与契约不符（应为数组）', traceId ?? '');
  }
  return resp as DisputeLike[];
}

/**
 * `POST /admin/users/{id}/block`（拉黑；不可逆，@see @limitation 二）。
 * @throws {ApiError} 缺 id 时不发请求（打到 `/admin/users//block` 会变成 404 而不是 40001）
 */
export async function blockUser(api: AdminApi, userId: string, traceId?: string): Promise<void> {
  if (userId.trim() === '') {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      '缺少用户 id（拉黑需要订单详情里的 user_id）',
      traceId ?? '',
    );
  }
  await api({
    path: `/api/v1/admin/users/${encodeURIComponent(userId.trim())}/block`,
    method: 'POST',
    ...(traceId !== undefined ? { traceId } : {}),
  });
}
