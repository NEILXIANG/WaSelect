/**
 * 职责：`webhook_events.result` 的**词表**——回调管线写、对账 job 读，两边只能引用这里。
 *
 * @why 全量审计（2026-09-26）P0：管线写的是 `ignored:status_conflict`，对账 SQL 精确匹配
 *      `'status_conflict'`；`'needs_refund'` 只出现在日志字段里，从未作为 result 写入——
 *      两个过滤值都是死的。后果：订单取消后机构仍回调成功（钱扣了、单关了）这一类**最需要人看**的
 *      异常，每日对账一条也扫不到；而 internal-jobs 的测试自己往表里塞了个 `needs_refund` 再扫出来，
 *      是同义反复。字符串散在两处必然漂，所以收成常量并让测试从这里取值。
 *
 * @limitation 只约束"写入用什么词"，不约束"写入了没有"——管线某个分支忘了 finish，这里管不了
 *             （由 pay-callback.unit / e2e 按分支断言）。
 *
 * @see app/pay-callback.ts（写入侧）；app/daily-reconciliation.ts（读取侧）；migrations/003（列宽）；
 *      docs/全量代码独立审计与修复报告-2026-09-26.md P0-1
 */

/** 落账成功。 */
export const RESULT_PAID = 'paid';
/** 订单已 paid、同单另一事件到达（正常形态）。 */
export const RESULT_PAID_ALREADY = 'paid:already';
/** 迟到付款：钱扣了但订单已过支付窗口——需人工退款。 */
export const RESULT_LATE_PAYMENT = 'late_payment';
/** 落账核对不通过（通道 / 机构单号 / 币种 / 金额 / 无支付意图）：`mismatch:<reason>`。 */
export const RESULT_MISMATCH_PREFIX = 'mismatch:';
/** 其它状态冲突（例如订单已 cancelled / expired 后机构仍回调成功）。 */
export const RESULT_STATUS_CONFLICT = 'ignored:status_conflict';
/** 超过宽限期订单仍不存在：`unmatched:<why>`。 */
export const RESULT_UNMATCHED_PREFIX = 'unmatched:';
/** 非 succeeded 结果被收下但不落账：`ignored:<outcome>`。 */
export const RESULT_IGNORED_PREFIX = 'ignored:';

/** `webhook_events.result` 列宽（migrations/003：VARCHAR(32)）——所有写入值必须 ≤ 它，否则 22001 → 500 → 机构无限重发。 */
export const RESULT_MAX_LEN = 32;
