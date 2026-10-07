/**
 * 职责：工作台的**接口层**——`GET /api/v1/admin/dashboard/sales`（AJ-393，契约 0.6.41）。
 *
 * @why 单独一个文件而不是塞进 `orders/api.ts`：那个文件的形状校验是"一张单/一页单"，
 *      这里是"聚合窗口"。混在一起会让"哪个断言守哪份契约"变得要逐条读。
 *
 * @limitation 一：与 `orders/api.ts` @limitation 一 同口径——**不吞形状错误**。
 *              200 但形状不符按网络层异常抛（NETWORK_ERROR_CODE），因为
 *              "契约被改了"与"今天没生意"在界面上必须能区分：
 *              前者是"数字看不了"，后者是"数字是 0"，运营对两者的动作完全不同。
 * @limitation 二：**缺 `today` / `last7` 就抛**，不回落成 0。
 *              ⚠️ 这里最容易写错的一条是"缺字段当 0"——
 *              那会让"接口挂了"在界面上显示成"今天一分钱没卖出去"，
 *              而这个数字会被拿去做经营判断（§8-2 定的"円为主"正是为了这个判断）。
 *
 * @see ../../../contracts/api-contract.yaml（AdminSalesOverview）；
 *      ../../../server/src/adapters/dashboard.ts（服务端口径的唯一出处）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

/** 契约 `MoneyByCurrency`：按币种分行的一笔钱（`amount` 恒为最小单位）。 */
export interface MoneyByCurrency {
  currency: string;
  amount: number;
}

/** 契约 `AdminSalesWindow`。 */
export interface SalesWindowLike {
  from?: string;
  to?: string;
  orders?: number;
  paid_orders?: number;
  sales_jpy?: number;
  /** 窗口内零收款订单时为 **null**（不是 0）。 */
  avg_jpy?: number | null;
  received?: MoneyByCurrency[];
  refunded?: MoneyByCurrency[];
  disputed?: MoneyByCurrency[];
}

/** 契约 `AdminSalesOverview`。`fx` 在没有已生效 USD 汇率时**整键不存在**。 */
export interface SalesOverviewLike {
  generated_at?: string;
  today?: SalesWindowLike;
  last7?: SalesWindowLike;
  fx?: { usd_rate?: number; usd_effective_from?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * @throws {ApiError} `today` / `last7` 缺失或不是对象（@see @limitation 二）
 */
export async function getSalesOverview(
  api: AdminApi,
  traceId?: string,
): Promise<SalesOverviewLike> {
  const resp = await api({
    path: '/api/v1/admin/dashboard/sales',
    ...(traceId !== undefined ? { traceId } : {}),
  });
  if (!isRecord(resp) || !isRecord(resp['today']) || !isRecord(resp['last7'])) {
    throw new ApiError(NETWORK_ERROR_CODE, '工作台统计响应形状与契约不符', traceId ?? '');
  }
  return resp as unknown as SalesOverviewLike;
}
