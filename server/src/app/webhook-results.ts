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
/**
 * 拒付已落库（`payments.dispute_*` + `orders.has_dispute`）。
 *
 * @why 与 `paid` 分开成一个词：对账/风控要能精确检索"哪些回调是拒付"。
 *      若沿用 `ignored:disputed`（U-F2 之前的行为），拒付在登记行里与
 *      "收下了但没反应"长得一样——而拒付是**有举证期限**的事，扫不到就是真金白银。
 */
export const RESULT_DISPUTED = 'disputed';
/** 拒付已结案（won / lost / withdrawn；`orders.has_dispute` 只在 won 与 withdrawn 时复位，lost 保持 true）。 */
export const RESULT_DISPUTE_CLOSED = 'dispute_closed';
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

/**
 * 拼一个 result 值，并保证它装得进 VARCHAR(32)。
 *
 * @why 词表常量的**长度**有单测钉着，但**运行时没有**任何东西拦：将来有人拼了
 *      `mismatch:<一个更长的 reason>`，写入即 22001 → 500，而回调返回 5xx 的后果
 *      不是"这一条丢了"，是机构**无限重发**。列宽是 DB 的形状约束，
 *      防线必须放在写入前的构造点（而不是等 DB 报错）。
 * @limitation 超长时**截断**而不是抛错：抛错同样把回调打成 5xx、同样触发重发，
 *              等于换一种方式制造同一个事故。代价是截断后丢失后缀——
 *              对账只看得到 `mismatch:` 这类前缀，具体 reason 要靠同一行的 note 与日志。
 *              这是拿"审计可读性"换"不放大故障"。
 * @tradeoff 截断时**不打日志**：本函数是纯函数（无 logger 注入），要告警就得把它传进来，
 *           而这是一条"词表与列宽同步时永远走不到"的分支；真正该守的是
 *           "扩展词表时同步改列宽"，那属于迁移评审，不是运行时的事。
 */
export function resultValue(prefix: string, suffix: string): string {
  const v = `${prefix}${suffix}`;
  return v.length <= RESULT_MAX_LEN ? v : v.slice(0, RESULT_MAX_LEN);
}
