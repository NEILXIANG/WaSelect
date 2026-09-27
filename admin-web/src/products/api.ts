/**
 * 职责：商品管理的**接口层**——路径、请求体、响应形状收口（与 `api/endpoints.ts` 同构）。
 *
 * @why 路径与响应形状集中在这里而不是散在组件里：契约改版时只查一个文件；
 *      且"响应形状校验"有统一落点——服务端改了形状时**在这里**硬失败，
 *      而不是让 undefined 流进 UI 变成"列表显示空白但不报错"。
 *
 * @limitation 一：**不吞形状错误**——200 但形状不符按网络层异常抛（NETWORK_ERROR_CODE），
 *              与 `endpoints.ts` 的 login 同口径。理由是"契约漂移"和"业务失败"
 *              是两种排查方向，混成一句"请求失败"会让后者反复查不到根因。
 * @limitation 二：列表接口的分页是 `page`/`size`（契约默认 1 / 50），
 *              前端**不实现无限滚动**：管理后台的商品量在百级，翻页足够，
 *              滚动加载会引入"当前在第几页"这类状态，收益不抵复杂度。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/products*）；./view.ts（请求体的生产者）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `AdminProduct` 里本模块真正读的字段（其余字段透传不校验）。 */
export interface AdminProductLike {
  id: string;
  title?: string;
  category?: string;
  price_jpy?: number;
  cost_jpy?: number;
  weight_g?: number;
  stock?: number;
  status?: string;
  description?: string;
  images?: Array<{ thumb?: string; card?: string; detail?: string }>;
  compliance_tags?: string[];
  hs_code?: string;
  customs_desc_en?: string;
  origin_country?: string;
  title_ja?: string;
  jan_code?: string;
  purchase_source?: string;
  updated_at?: string;
}

export interface ProductListResp {
  items: AdminProductLike[];
  total: number;
}

/** 列表查询参数（契约：`status` 可选、`page`/`size` 有默认值）。 */
export interface ProductListQuery {
  status?: 'active' | 'offline';
  page?: number;
  size?: number;
}

/**
 * `GET /admin/products`。
 * @throws {ApiError} 响应形状与契约不符（不是"没有商品"——空列表是 `{items:[],total:0}`）
 */
export async function listProducts(
  api: AdminApi,
  query: ProductListQuery = {},
  traceId?: string,
): Promise<ProductListResp> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.size !== undefined) params.set('size', String(query.size));
  const qs = params.toString();
  const resp = await api({
    path: `/api/v1/admin/products${qs === '' ? '' : `?${qs}`}`,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertProductList(resp, traceId ?? '');
  return resp;
}

/** `POST /admin/products`（新建）。 */
export async function createProduct(
  api: AdminApi,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<AdminProductLike> {
  const resp = await api({
    path: '/api/v1/admin/products',
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertProduct(resp, traceId ?? '');
  return resp;
}

/** `PUT /admin/products/{id}`（全量更新）。 */
export async function updateProduct(
  api: AdminApi,
  id: string,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/products/${encodeURIComponent(id)}`,
    method: 'PUT',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/**
 * `PATCH /admin/products/{id}/status`（上下架）。
 * @why 上下架走独立的 PATCH 而不是整条 PUT：PUT 要把整条商品重新提交一遍，
 *      两个管理员同时改（一个改价格、一个下架）会互相覆盖——
 *      而"下架"这个动作本身只需要一个字段。
 */
export async function setProductStatus(
  api: AdminApi,
  id: string,
  status: 'active' | 'offline',
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/products/${encodeURIComponent(id)}/status`,
    method: 'PATCH',
    body: { status },
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** 列表响应形状校验（@see @limitation 一）。 */
function assertProductList(value: unknown, traceId: string): asserts value is ProductListResp {
  const o = value as { items?: unknown; total?: unknown } | null;
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(o?.items) ||
    !o.items.every((p) => typeof (p as { id?: unknown } | null)?.id === 'string')
  ) {
    throw new ApiError(NETWORK_ERROR_CODE, '商品列表响应形状与契约不符', traceId);
  }
  if (typeof o?.total !== 'number') {
    throw new ApiError(NETWORK_ERROR_CODE, '商品列表缺 total（分页无法判断到底）', traceId);
  }
}

/** 单个商品响应形状校验。 */
function assertProduct(value: unknown, traceId: string): asserts value is AdminProductLike {
  if (typeof (value as { id?: unknown } | null)?.id !== 'string') {
    throw new ApiError(NETWORK_ERROR_CODE, '商品响应形状与契约不符（缺 id）', traceId);
  }
}
