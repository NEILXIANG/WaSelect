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
  /**
   * `image_id`：0.6.29 / AJ-362 起，条目**按 id 存**时服务端回显它（编辑页靠它回存 id）；
   * 存量条目（三档 URL）没有这个键。
   */
  images?: Array<{ thumb?: string; card?: string; detail?: string; image_id?: string }>;
  compliance_tags?: string[];
  hs_code?: string;
  customs_desc_en?: string;
  origin_country?: string;
  title_ja?: string;
  jan_code?: string;
  purchase_source?: string;
  updated_at?: string;
  /**
   * 编辑口径三列（020 迁移新增，无前缀——契约里就是这三个名字）。
   *
   * @why 本接口**必须**收下它们：编辑页的原始数据是从列表页整条带过来的
   *      （@see ProductFormPage 文件头：契约没有 `GET /admin/products/{id}`），
   *      这里漏一个，`productFormModel` 就把它映射成空值，
   *      而 PUT 是整行覆盖 → 运营改价保存即抹掉编辑撰写的 `why`，且不报错。
   * @why 键名**不加** `compliance` 前缀：这是**服务端下行**的形状，
   *      只有表单模型（view.ts 的 `ProductForm`）才需要区分两套标签。
   */
  why?: string;
  maker?: string;
  tags?: string[];
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

/** 翻页查找单条时最多翻几页（× 100 条/页）：管理端商品量在百级（@limitation 二），20 页是余量。 */
const FIND_MAX_PAGES = 20;

/**
 * 按 id 取一条商品的**最新版本**（40914 冲突后"加载最新值对照"用，P2-44）。
 * @why 契约没有 `GET /admin/products/{id}`，只能翻列表找；size 取契约上限 100 减少往返。
 * @returns 找不到（已被删除 / 超出翻页上限）为 null
 * @limitation 翻页期间列表若有增删，可能漏看一条（顺延到下一页）；对照用途下可接受，找不到时会明说。
 */
export async function findProductById(api: AdminApi, id: string): Promise<AdminProductLike | null> {
  for (let page = 1; page <= FIND_MAX_PAGES; page += 1) {
    const { items, total } = await listProducts(api, { page, size: 100 });
    const hit = items.find((p) => p.id === id);
    if (hit !== undefined) return hit;
    if (items.length === 0 || page * 100 >= total) return null;
  }
  return null;
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

/**
 * `PUT /admin/products/{id}`（全量更新，**带乐观锁凭据**）。
 *
 * @param expectedUpdatedAt 编辑页打开时那一行的 `updated_at`（`sourceUpdatedAt` 取）。
 *       服务端拿它做 `where updated_at = $x`：对不上 → **40914**，整行不写。
 * @why 凭据是**独立参数**而不是让调用方塞进 `body`：PUT 是整行覆盖，
 *      运营只补一张图保存就会把期间别人改过的售价/重量/报关品名整条回滚，且不报错。
 *      独立的必填参数让"忘了带"在**编译期**就过不去，而塞进 body 的写法
 *      缺了字段也能编译、只在真服务端上才暴露（ADM3-02）。
 */
export async function updateProduct(
  api: AdminApi,
  id: string,
  body: Record<string, unknown>,
  expectedUpdatedAt: string,
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/products/${encodeURIComponent(id)}`,
    method: 'PUT',
    // ⚠️ 与 `ProductInput` **并列**而不是嵌套：它不属于商品字段（服务端同口径，
    //    见 server/src/app/admin-product-routes.ts 的 expectedUpdatedAtOf 注释）。
    body: { ...body, expected_updated_at: expectedUpdatedAt },
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
