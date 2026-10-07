/**
 * 职责：**审核模式（`REVIEW_MODE`）的"到期"口径**——截止日的解析、剩余天数、该不该提醒。
 *
 * @why 单独成文件而不是写进 `config.ts`：同一个截止日有**三方**要用——
 *      ① 启动闸门（`config.ts` crossField 2d / 2e / 2f）；
 *      ② 每日对账的提醒类（`app/daily-reconciliation.ts`）；
 *      ③ 这两处的测试。
 *      判据出现三份 = 三份各自漂移（§2 第 60 条），而这里漂移的表现恰好是"**永不过期**"——
 *      即 A7 那条"忘了关也不会红"的洞又原样回来，且完全看不出来。
 *
 * @why 解析失败返回 `undefined`，而**不是** 0 / 空串 / "当作永不过期"：
 *      返回 0 会把"填了个不存在的日期"读成"今天到期"；返回空串会让字符串比较永远为假——
 *      后一种尤其坏：闸门**静默失效**，且它的表现与"一切正常"一模一样（空对空假绿灯，§2 第 87 条）。
 *      调用方拿到 `undefined` 只有一条路可走：拒绝。
 *
 * @limitation 一：一律按 **UTC 日历日**判定，不认时区。对日本站而言这等于比填写的日期
 *              多给了约 9 小时（日本时间次日上午才切日）——宽容方向是刻意的：
 *              误红的代价是改一行配置再重启，误绿的代价是真实买家下一张永远发不出货的假单。
 * @limitation 二：只认 `YYYY-MM-DD`。不接受 `2026-11-15T00:00:00Z` 这类带时刻的写法——
 *              "截止到某一刻"会把"再给我一小时"变成日常请求，而日历日足够表达一个审核期。
 * @limitation 三：不做"上限"（不允许填 2099 年）。填一个荒谬的远期日期确实能让闸门失去意义，
 *              但它是**写在配置里、人看得见**的荒谬——与"没填"这种看不见的失效不是同一类，
 *              而机器上再加一条上限只会把"审核拖了半年"也判成配置错误。
 *
 * @see server/src/config.ts（规则 2d/2e/2f）；server/src/app/daily-reconciliation.ts（第七类）
 */
/** 截止日的唯一合法形态。 */
const REVIEW_UNTIL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 一天的毫秒数（仅用于日历日相减，不做时区换算）。 */
const MS_PER_DAY = 86_400_000;

/**
 * 距到期还剩几天时开始**每天**提醒（含当天与已过期）。
 *
 * @why 3 天而不是"开着就每天报"：审核期通常持续一两周，天天报同一句话
 *      会让人把这类告警当噪音关掉——而"人把告警关掉"比"晚 3 天发现"贵得多
 *      （`app/daily-heartbeat-watch.ts` @limitation 二 同为这条教训）。
 *      最后 3 天开始报，是"来得及改配置"与"不打扰"之间的分界。
 */
export const REVIEW_WINDOW_WARN_DAYS = 3;

/** 取某个时刻所在的 **UTC 日历日**（`YYYY-MM-DD`）。 */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 平年各月天数（下标 = 月份 - 1）。 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 格里高利闰年：能被 4 整除，且（不能被 100 整除 **或** 能被 400 整除）。 */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * 把 `REVIEW_MODE_UNTIL` 解析成可比较的日历日；**不合法返回 `undefined`**。
 *
 * @why 日期的**存在性自己算**，不交给 `Date` 解析——两条理由，第二条更要紧：
 *      ① F10 禁业务侧 `new Date()`（时间只从外面进来）；
 *      ② **`Date` 的解析会静默滚动**：`2026-02-30` 形状完全合法，而它会被读成 `2026-03-02`——
 *         于是"填错了日期"变成"填了一个更晚的正确日期"，**闸门被推迟十一天且没有任何提示**。
 *         这正是本模块最该防的失效形态：看起来一切正常，只是到期日悄悄挪了。
 *         自己算则把"拒绝"还给调用方（`undefined` 只有一条路可走）。
 * @why 闰年规则写在这里而不是"相信 `Date` 知道"：它现在是**可断言的**（1900 不是闰年、2000 是），
 *      而依赖 `Date` 时它只是"库恰好这么实现"，改不了也测不到边界。
 */
export function parseReviewUntil(value: string): string | undefined {
  if (!REVIEW_UNTIL_PATTERN.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return undefined;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day >= 1 && day <= maxDay ? value : undefined;
}

/**
 * 从 `fromUtcDay` 到 `untilDay` 还剩几天；**负数表示已过期**（0 = 当天，仍算未过期）。
 *
 * @why 含当天：填 `2026-11-15` 的人心里想的是"15 号这天还能用"。
 *      把它判成过期，会让"如期进行"的审核期在最后一天起不来。
 * @param fromUtcDay 已校验的 `YYYY-MM-DD`（"今天"，UTC）
 * @param untilDay **已由 {@link parseReviewUntil} 校验过**的 `YYYY-MM-DD`
 */
export function daysUntil(fromUtcDay: string, untilDay: string): number {
  const from = Date.parse(`${fromUtcDay}T00:00:00Z`);
  const until = Date.parse(`${untilDay}T00:00:00Z`);
  return Math.round((until - from) / MS_PER_DAY);
}
