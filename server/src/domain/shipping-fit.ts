/**
 * 职责：在售商品"单件 + 包材"能不能被**当前生效运费表**装下（P2-30）。纯函数，无 IO。
 *
 * @why 商品重量上界 `PRODUCT_MAX_WEIGHT_G` 跟的是运费表**结构上**能装多重（30kg），不是**实际配了**多重。
 *      表只配到 10kg 时 10–29kg 的商品照样能上架，买家报价才撞 40912——问题暴露在最晚的一步。
 *      这里把"装不装得下"提前到上架 / 换表这两个运营动作上。
 * @why 包材按 `PACKAGING_WEIGHT_G` 加：与报价同口径（quote-assembly.ts `goodsWeightG + PACKAGING_WEIGHT_G`），
 *      取档也是"最高档 >= 重量"（D-46 向上取档）——两处口径不同就会出现"上架放行、报价超重"。
 * @limitation 只判**单件**。多件合单超出最高档仍由报价的 40912（请拆单）处理，那是买家侧的正常分支。
 * @limitation 多承运商时取所有生效档的最大值；报价要求恰好一家生效承运商（多家即 50004），
 *             那种配置下本判断偏宽，但报价本身已不可用，不在这里重复拦。
 */

/**
 * @param maxTierWeightG 生效档的最高 `max_weight_g`；`null` = 没有任何生效档（不判：此时报价本就 50004，
 *        不该连商品都建不了——运营往往先建商品、后配运费）。
 */
export function fitsShippingTable(
  weightG: number,
  packagingWeightG: number,
  maxTierWeightG: number | null,
): boolean {
  if (maxTierWeightG === null) return true;
  return weightG + packagingWeightG <= maxTierWeightG;
}
