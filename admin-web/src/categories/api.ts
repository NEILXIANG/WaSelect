/**
 * 职责：后台商品分类接口的封装（契约 0.6.74 `/admin/categories`，AJ-491）。
 * @why 响应形状不符就抛（同 banners/api.ts）：列表拿到非数组时让页面显示"加载失败"，而不是空表（空表会让运营以为分类被删光了）。
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

export interface AdminCategory {
  key: string;
  name: string;
  sort: number;
  active: boolean;
  active_product_count: number;
  product_count: number;
}

export async function listCategories(api: AdminApi): Promise<AdminCategory[]> {
  const resp = await api({ path: '/api/v1/admin/categories' });
  const items = (resp as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new ApiError(NETWORK_ERROR_CODE, '分类列表响应形状与契约不符（应为 {items: []}）', '');
  }
  return items as AdminCategory[];
}

export async function createCategory(
  api: AdminApi,
  body: { key: string; name: string; sort: number },
): Promise<void> {
  await api({ path: '/api/v1/admin/categories', method: 'POST', body });
}

export async function updateCategory(
  api: AdminApi,
  key: string,
  body: { name?: string; sort?: number; active?: boolean },
): Promise<void> {
  await api({ path: `/api/v1/admin/categories/${encodeURIComponent(key)}`, method: 'PUT', body });
}

export async function deleteCategory(api: AdminApi, key: string): Promise<void> {
  await api({ path: `/api/v1/admin/categories/${encodeURIComponent(key)}`, method: 'DELETE' });
}
