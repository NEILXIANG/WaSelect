/**
 * 职责：运营配置的**接口层**（展示汇率 / 运费分档）。
 *
 * @why 与 `orders/api.ts` 同口径：形状校验集中在这里，服务端改形状时在这里硬失败，
 *      而不是让 undefined 流进表格（"汇率那一列空白"会被当成"今天没配汇率"）。
 *
 * @limitation 一：两个 GET 返回的都是**裸数组**（契约不是 `{items,total}`），
 *              所以校验就是"必须是数组"——⚠️ 与列表类接口不同，别照抄 `{items:[]}` 的写法。
 * @limitation 二：`PUT /admin/shipping-rates` 是**整表替换**（契约明文）：
 *              没有"改一档"的接口，所以任何一次保存都是"用你提交的这张表替换全部"。
 *              调用方必须先把当前表取回来再改（页面层已如此实现），
 *              否则一次保存会把别人刚配的档位抹掉。
 *
 * @see ../../../contracts/api-contract.yaml（/admin/fx、/admin/shipping-rates）；./view.ts
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `FxRate`。 */
export interface FxRateLike {
  quote?: string;
  rate?: number;
  raw_rate?: number;
  buffer?: number;
  effective_from?: string;
  /**
   * 这一行是否**当前已生效**，由**服务端**按自己的时钟判定（ADM3-05）。
   * @why 前端不拿本机时钟推：管理员电脑的时钟偏差会让"刚保存的立即生效行"被当成未来行。
   */
  is_current?: boolean;
}

/** 契约 `ShippingRate`。 */
export interface ShippingRateLike {
  carrier?: string;
  max_weight_g?: number;
  price_jpy?: number;
  active?: boolean;
}

/**
 * `GET /admin/fx`（展示汇率**全量**：历史 + 未来生效行）。
 *
 * ⚠️ 不叫"当前生效"（ADM3-07）：服务端**不过滤**——过滤掉未来行会让"刚保存的预约汇率"
 * 在列表里消失，运营以为没保存成功（AJ-150 ①）。"哪一行当前生效"由每行的 `is_current`
 * 单独标注（服务端时钟判定，ADM3-05），调用方读它，别自己跟本机时间比。
 *
 * @throws {ApiError} 响应不是数组（契约是裸数组）
 */
export async function listFx(api: AdminApi, traceId?: string): Promise<FxRateLike[]> {
  const resp = await api({
    path: '/api/v1/admin/fx',
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertArray(resp, '展示汇率列表', traceId ?? '');
  return resp as FxRateLike[];
}

/** `POST /admin/fx`（维护展示汇率；`quote` + `raw_rate` 必填）。 */
export async function setFx(
  api: AdminApi,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<void> {
  await api({
    path: '/api/v1/admin/fx',
    method: 'POST',
    body,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** `GET /admin/shipping-rates`。 */
export async function listShippingRates(
  api: AdminApi,
  traceId?: string,
): Promise<ShippingRateLike[]> {
  const resp = await api({
    path: '/api/v1/admin/shipping-rates',
    ...(traceId !== undefined ? { traceId } : {}),
  });
  assertArray(resp, '运费分档', traceId ?? '');
  return resp as ShippingRateLike[];
}

/**
 * `PUT /admin/shipping-rates`（**整表替换**，@see @limitation 二）。
 * @why 响应不读：契约只给 200，没有返回体；"是否成功"由下一次 GET 决定，
 *      页面层保存后立刻重新拉一次表——凭空造一个 `{count}` 只会造出永不兑现的字段。
 */
export async function replaceShippingRates(
  api: AdminApi,
  rows: Array<Record<string, unknown>>,
  /** 读表时算的指纹（AJ-458）：服务端在锁内比对，表已被别人改过 → 40914 */
  expected?: string,
  traceId?: string,
): Promise<void> {
  await api({
    path: `/api/v1/admin/shipping-rates${expected === undefined ? '' : `?expected=${expected}`}`,
    method: 'PUT',
    body: rows,
    ...(traceId !== undefined ? { traceId } : {}),
  });
}

/** 裸数组响应校验（@see @limitation 一）。 */
function assertArray(value: unknown, label: string, traceId: string): void {
  if (!Array.isArray(value)) {
    throw new ApiError(NETWORK_ERROR_CODE, `${label}响应形状与契约不符（应为数组）`, traceId);
  }
}
