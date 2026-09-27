/**
 * 职责：`PUT /admin/shipping-rates` 的**整表**校验（I2 U-C1）。
 *
 * @why 校验粒度必须是**整表**而不是"逐条"：契约明文这是**整表替换**，
 *      单条全部合法、整表仍然可能是错的（空表 / 重复档 / 两家承运商同时启用），
 *      而这三类的表现全都一样——"保存成功，然后某些重量取不到档或全站报不了价"。
 *      逐条校验会把它们全部放过，而且不报错（与 D-46 取档方向同源的静默）。
 *
 * @why 🔴 "启用的承运商必须恰好一家"是本函数**最要紧**的一条：
 *      `adapters/catalog.ts` 的 `resolveSingleActiveCarrier()` 在活跃承运商 ≠1 家时返回 null，
 *      调用方随即抛 **50004 运费不可计算**——即**全站报价与建单全部失败**。
 *      `shipping_rates` 这张表唯一能改变该不变量的操作就是本接口（整表替换），
 *      所以守卫必须在**这里**，不能指望 DB 约束（UNIQUE(carrier, max_weight_g) 只挡重复档，
 *      不挡"两家承运商"）。
 *
 * @limitation 一：⚠️ **没有重量上界 / 价格上界的量纲护栏**——
 *              2000 打成 20000 会让所有包裹落进最便宜那一档，每单少收钱且不报错。
 *              不做的原因与 fx-input @limitation 二 同源：需要一个"合理区间"的运营参数，
 *              没拍板；本单元只补"可观测"（路由层把替换前后的档数打进日志），
 *              数量级错误目前靠页面二次确认 + 对账发现。登记为待办。
 * @limitation 二：不校验"档位是否连续覆盖"（比如只有 500g 一档，1kg 的包裹取不到档）。
 *              覆盖率是运营决策（有些重量本来就不卖），且超重已有 50004 兜底——
 *              拦在保存时会让"刻意只留一档"的合法配置也存不进去。
 *
 * @see contracts/api-contract.yaml（ShippingRate / PUT /admin/shipping-rates）；
 *      adapters/catalog.ts（D-46 唯一取档 SQL + resolveSingleActiveCarrier）；
 *      admin-web/src/ops/view.ts（前端同一套整表校验：rateErrors）
 */
import { AppError } from '../errors.js';

/** 列宽（与 001 的 VARCHAR(32) 一致）：超长属"形状错"（40001），DB 兜底是最后一道。 */
const MAX_CARRIER_LEN = 32;

/** 校验后的一档运费（提交给仓储的形状）。 */
export interface ShippingRateInput {
  carrier: string;
  maxWeightG: number;
  priceJpy: number;
  active: boolean;
}

/**
 * 校验并取出整张运费表（纯：不查库、不取时钟）。
 * @throws {AppError} 40001 形状 / 数值域 / 整表约束（见文件头 @why）
 */
export function parseShippingRates(body: unknown): ShippingRateInput[] {
  if (!Array.isArray(body)) throw new AppError(40001, { reason: 'body_shape' });
  if (body.length === 0) throw new AppError(40001, { reason: 'rates_empty' });

  const out: ShippingRateInput[] = [];
  const seen = new Set<string>();
  const activeCarriers = new Set<string>();

  body.forEach((raw, i) => {
    const r = raw as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object') {
      throw new AppError(40001, { reason: 'row_shape', index: i });
    }
    const carrier = typeof r['carrier'] === 'string' ? r['carrier'].trim() : '';
    if (carrier === '' || carrier.length > MAX_CARRIER_LEN) {
      throw new AppError(40001, { reason: 'carrier_invalid', index: i });
    }
    const maxWeightG = r['max_weight_g'];
    const priceJpy = r['price_jpy'];
    if (!Number.isInteger(maxWeightG) || (maxWeightG as number) < 1) {
      throw new AppError(40001, { reason: 'max_weight_g_invalid', index: i });
    }
    // 0 円运费合法（手动包邮）；负数不是
    if (!Number.isInteger(priceJpy) || (priceJpy as number) < 0) {
      throw new AppError(40001, { reason: 'price_jpy_invalid', index: i });
    }
    const key = `${carrier}|${String(maxWeightG)}`;
    if (seen.has(key)) throw new AppError(40001, { reason: 'tier_duplicated', index: i });
    seen.add(key);

    const active = r['active'] !== false;
    if (active) activeCarriers.add(carrier);
    out.push({ carrier, maxWeightG: maxWeightG as number, priceJpy: priceJpy as number, active });
  });

  if (activeCarriers.size === 0) throw new AppError(40001, { reason: 'no_active_tier' });
  // 🔴 D-46 同源守卫：≠1 家活跃承运商 = 全站 50004（文件头 @why）
  if (activeCarriers.size !== 1) {
    throw new AppError(40001, { reason: 'carrier_not_single', carriers: [...activeCarriers] });
  }
  return out;
}
