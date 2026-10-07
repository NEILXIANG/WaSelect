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

export interface BlockUserInput {
  /** 要拉黑的用户（订单详情里的 `user_id`）。 */
  userId: string;
  /**
   * **可选**：发起这次拉黑的那一单（面板上那一单）。
   * @why 带上它的唯一理由是让服务端核对"这张单属于这个人"（ADM3-01 纵深防御，契约 0.6.21）：
   *      拉黑不可逆且没有解除接口，多一道凭据核对的成本是几个字节。
   *      ⚠️ 它**不**解决"人看错了面板"——那一层是面板清空（AJ-256）。
   */
  orderId?: string | undefined;
}

/**
 * `POST /admin/users/{id}/block`（拉黑；不可逆，@see @limitation 二）。
 *
 * @throws {ApiError} 缺 id 时不发请求（打到 `/admin/users//block` 会变成 404 而不是 40001）
 */
export async function blockUser(
  api: AdminApi,
  input: BlockUserInput,
  traceId?: string,
): Promise<void> {
  const userId = input.userId.trim();
  const orderId = input.orderId?.trim();
  if (userId === '') {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      '缺少用户 id（拉黑需要订单详情里的 user_id）',
      traceId ?? '',
    );
  }
  await api({
    path: `/api/v1/admin/users/${encodeURIComponent(userId)}/block`,
    method: 'POST',
    // 空串当"没带"，而不是发一个 `order_id: ""` 去撞 40001：
    // 面板只在拿到 orderId 时才出现，走到这里而 orderId 为空属于不该发生的分支，
    // 但真发生了也该照常拉黑——凭据是**加**上去的保险，不是拉黑的前置条件。
    ...(orderId === undefined || orderId === '' ? {} : { body: { order_id: orderId } }),
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** 已拉黑用户一行（`GET /admin/users?blocked=true`，AJ-384）。 */
export interface BlockedUser {
  id: string;
  blocked_at: string;
  order_count: number;
  /** 最近一单的收件人 / 联系邮箱（契约 0.6.40；没有时缺省）。 */
  last_recipient?: string;
  last_contact_email?: string;
}

/** `GET /admin/users?blocked=true`：形状不对的行丢掉（不让一行脏数据拖垮整张表）。 */
export async function listBlockedUsers(api: AdminApi): Promise<BlockedUser[]> {
  const res = await api({ path: '/api/v1/admin/users?blocked=true', method: 'GET' });
  const items = (res as { items?: unknown } | null)?.items;
  return (Array.isArray(items) ? items : []).flatMap((r: Record<string, unknown>) =>
    typeof r?.['id'] === 'string' && typeof r['blocked_at'] === 'string'
      ? [
          {
            id: r['id'],
            blocked_at: r['blocked_at'],
            order_count: Number(r['order_count'] ?? 0),
            ...(typeof r['last_recipient'] === 'string'
              ? { last_recipient: r['last_recipient'] }
              : {}),
            ...(typeof r['last_contact_email'] === 'string'
              ? { last_contact_email: r['last_contact_email'] }
              : {}),
          },
        ]
      : [],
  );
}

/** `POST /admin/users/{id}/unblock`（AJ-384）：原因必填（进审计）。 */
export async function unblockUser(api: AdminApi, userId: string, reason: string): Promise<void> {
  await api({
    path: `/api/v1/admin/users/${encodeURIComponent(userId)}/unblock`,
    method: 'POST',
    body: { reason },
  });
}
