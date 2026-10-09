/**
 * 职责：客户页的**接口层**（AJ-404，契约 0.6.47）——`GET /admin/customers`、`GET /admin/customers/{id}`。
 *       拉黑 / 解除复用 `../risk/api.ts` 的 `blockUser` / `unblockUser`（同一对服务端接口，不另起封装）。
 *
 * @limitation 与 `dashboard/api.ts` @limitation 一同口径：形状不符**按网络层异常抛**（NETWORK_ERROR_CODE），
 *             不回落成空列表 / 空详情——"契约变了"与"没有客户"在页面上必须能区分。
 * @see ./view.ts；../../../contracts/api-contract.yaml（AdminCustomerListItem / AdminCustomer）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import { customerListQuery, type CustomerDetailLike, type CustomerListItem } from './view.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function shapeError(what: string): ApiError {
  return new ApiError(NETWORK_ERROR_CODE, `${what}响应形状与契约不符`, '');
}

export async function listCustomers(
  api: AdminApi,
  q: { keyword: string; page: number; sort?: string; size?: number },
): Promise<{ items: CustomerListItem[]; total: number }> {
  const resp = await api({ path: `/api/v1/admin/customers${customerListQuery(q)}` });
  if (!isRecord(resp) || !Array.isArray(resp['items']) || typeof resp['total'] !== 'number') {
    throw shapeError('客户列表');
  }
  return { items: resp['items'] as CustomerListItem[], total: resp['total'] };
}

export async function getCustomer(api: AdminApi, id: string): Promise<CustomerDetailLike> {
  const resp = await api({ path: `/api/v1/admin/customers/${encodeURIComponent(id)}` });
  if (
    !isRecord(resp) ||
    typeof resp['id'] !== 'string' ||
    !isRecord(resp['stats']) ||
    !isRecord(resp['risk']) ||
    !Array.isArray(resp['addresses']) ||
    !Array.isArray(resp['orders'])
  ) {
    throw shapeError('客户详情');
  }
  return resp as unknown as CustomerDetailLike;
}

/**
 * 删除该客户的全部用户行为记录（AJ-413，契约 0.6.51）——APPI「用户要求删除」的后台路径。
 * @why 返回值必须是 `{deleted: number}`：形状不符按网络层异常抛，不回落成 0——"删了 0 条"与"接口变了"对运营是两件事。
 */
export async function purgeCustomerEvents(
  api: AdminApi,
  id: string,
  reason: string,
): Promise<{ deleted: number }> {
  const resp = await api({
    path: `/api/v1/admin/customers/${encodeURIComponent(id)}/events`,
    method: 'DELETE',
    body: { reason },
  });
  if (!isRecord(resp) || typeof resp['deleted'] !== 'number') throw shapeError('删除行为记录');
  return { deleted: resp['deleted'] };
}
