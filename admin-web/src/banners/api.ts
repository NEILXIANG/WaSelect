/**
 * 职责：Banner 的**接口层**（`ops/api.ts` 同构）。
 *
 * @limitation 一：`DELETE /admin/banners/{id}` 返回 **204 空体**——
 *              与 `orders/api.ts` 的写接口不同，这里连 JSON 都没有。
 *              @see ../api/client.ts（204 与 `content-length: 0` 已按空体处理，不当网络失败）。
 * @limitation 二：列表是**裸数组**（同 `ops/api.ts` @limitation 一），不是 `{items,total}`。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/banners*）；./view.ts
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `Banner`。 */
export interface BannerLike {
  id: string;
  image_key?: string;
  image?: string;
  link_type?: string;
  link_id?: string;
  sort?: number;
  active?: boolean;
  starts_at?: string;
  ends_at?: string;
  /** 管理端列表回显（S-09）：保存时作为乐观锁凭据 `expected_updated_at` 发回去。 */
  updated_at?: string;
}

/** `GET /admin/banners`。 */
export async function listBanners(api: AdminApi, traceId?: string): Promise<BannerLike[]> {
  const resp = await api({
    path: '/api/v1/admin/banners',
    ...(traceId !== undefined ? { traceId } : {}),
  });
  if (!Array.isArray(resp)) {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      'Banner 列表响应形状与契约不符（应为数组）',
      traceId ?? '',
    );
  }
  return resp as BannerLike[];
}

/** `POST /admin/banners`（新建；返回带 id 的 Banner）。 */
export async function createBanner(
  api: AdminApi,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<BannerLike> {
  const resp = await api({
    path: '/api/v1/admin/banners',
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  if (typeof (resp as { id?: unknown } | null)?.id !== 'string') {
    throw new ApiError(
      NETWORK_ERROR_CODE,
      '新建 Banner 响应缺 id（后面编辑会打到 /undefined）',
      traceId ?? '',
    );
  }
  return resp as BannerLike;
}

/** `PUT /admin/banners/{id}`（全量更新）。 */
export async function updateBanner(
  api: AdminApi,
  id: string,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/banners/${encodeURIComponent(id)}`,
    method: 'PUT',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** `DELETE /admin/banners/{id}`（204；@see @limitation 一）。 */
export async function deleteBanner(api: AdminApi, id: string, traceId?: string): Promise<void> {
  await api({
    path: `/api/v1/admin/banners/${encodeURIComponent(id)}`,
    method: 'DELETE',
    ...(traceId !== undefined ? { traceId } : {}),
  });
}
