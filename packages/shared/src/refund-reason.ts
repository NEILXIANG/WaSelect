/**
 * 职责：退款原因的预设词表与"缺货"判定——管理端下拉、服务端落定回补库存共用一份（AJ-427，统一结论 5.2）。
 *
 * @why 词表原在管理端（AJ-400 只为统计）；"缺货不回补库存"让服务端也要认它，两份词表一改就分叉，所以上移到 shared。
 * @why 判定只认**预设格式**（整串 = `缺货`，或以 `缺货：` 开头）：预设是运营在下拉里的明确选择；
 *      历史自由文本（"没货""断货""缺货了"）不猜，按原行为回补——猜错的代价是把有货的单少记库存。
 * @limitation 一：契约里 `reason` 仍是一个自由字符串；不经管理端、直接调接口写"缺货"也会被认成缺货（同一个运营动作，属预期）。
 * @limitation 二：改词（例如把「缺货」改名）会让历史退款不再被认出——本判定只用于落定那一刻，不回溯历史。
 * @see admin-web/src/orders/refund-reason.ts（拼接与长度校验）；server/src/app/refund-execution.ts、partial-refund.ts（落定）
 */

export const REFUND_REASON_PRESETS = ['缺货', '破损', '错发', '买家取消', '其它'] as const;

/** 预设与补充说明之间的分隔符（全角冒号）。 */
export const REFUND_REASON_SEPARATOR = '：';

/** 退款落定时**不回补库存**的预设：货本来就没有，加回去等于重新开卖一件买不到的东西。 */
export const OUT_OF_STOCK_REFUND_PRESET = '缺货';

export function isOutOfStockRefundReason(reason: string): boolean {
  return (
    reason === OUT_OF_STOCK_REFUND_PRESET ||
    reason.startsWith(`${OUT_OF_STOCK_REFUND_PRESET}${REFUND_REASON_SEPARATOR}`)
  );
}
