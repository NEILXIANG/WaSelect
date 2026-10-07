/**
 * 职责：JST（日本时间）业务日工具——结算周期、调度窗口、单号日期都按 JST 计算（地基 F2b）。
 * 边界：纯函数，零依赖。
 * @see 技术文档 v0.5 §6.1（调度按日）、结算月 2 回；评审 #5
 * @limitation 固定 +09:00 偏移，**不使用 IANA tz 数据库**：日本自 1951 年后无夏令时，故 MVP 安全；
 *             若将来要处理历史日期或日本改行夏令时，必须换成 `Intl.DateTimeFormat` 并补属性测试。
 * @tradeoff 不引入 date-fns/tz：省一个依赖 + 行为完全可预测；代价是不支持任意时区（MVP 只需要 JST 与 UTC）。
 * @why 结算周期、调度窗口、单号里的日期都必须按 **JST**，而运行环境的本地时区是不确定的
 *      （Render 上是 UTC，本机是 Asia/Shanghai）。各处自己 `new Date()` 会得到不同的日历日。
 */

export const JST_OFFSET_MIN = 9 * 60;

/** 把时刻转成 JST 的日历字段（年月日时分）。 */
export function toJstParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const shifted = new Date(at.getTime() + JST_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** JST 日期字符串 YYYY-MM-DD。 */
export function jstDate(at: Date): string {
  const p = toJstParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** JST 日期紧凑串 YYYYMMDD。 */
export function jstDateCompact(at: Date): string {
  return jstDate(at).replaceAll('-', '');
}

/**
 * JST 日期的 **YYMMDD**（6 位）——订单号日期段用。
 * @see 技术文档 v0.5 §1：`order_no` = `YYMMDD` + 6 位 base32（例 `260919-K7Q2MN`；
 *      旧示例 `…K7Q2ML` 含被 Crockford 排除的 `L`，会被 `formatOrderNo` 拒绝，已更正）
 */
export function jstDateShort(at: Date): string {
  return jstDateCompact(at).slice(2);
}

/** JST 当日 00:00 对应的 UTC 时刻（用于按日分组与调度窗口）。 */
export function startOfJstDayUtc(at: Date): Date {
  const p = toJstParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - JST_OFFSET_MIN * 60_000);
}

/** 两个时刻是否属于同一 JST 业务日。 */
export function isSameJstDay(a: Date, b: Date): boolean {
  return jstDate(a) === jstDate(b);
}

/**
 * JST 当日 00:00 **往前推 `days` 天**的 UTC 时刻（含当日在内的 N 日窗口起点用 `days = N - 1`）。
 *
 * @why 放在 shared 而不是服务端业务层：那里禁止 `new Date()`（F10，时钟必须注入），
 *      而"把一天的开始往前挪几天"是**纯算术**，不涉及取当前时间——
 *      挪到这里既守住了那条规则，又让这段算术有单元测试（挪进适配器就只能靠真库用例间接覆盖）。
 * @limitation 按 24 小时整挪，不经由日历加减：JST 无夏令时（@see 文件头 @limitation），
 *             所以"一天前"恒等于"减 24 小时"；将来若改行夏令时，这里必须跟着换成日历运算。
 */
export function startOfJstDayUtcMinusDays(at: Date, days: number): Date {
  return new Date(startOfJstDayUtc(at).getTime() - days * 86_400_000);
}

/** 一个**左闭右开**的时间窗口（`from` 含，`to` 不含）。 */
export interface JstDayWindow {
  from: Date;
  to: Date;
}

/**
 * 以 `at` 所在 JST 日**为最后一天**、往前含 **`days` 个自然日**的窗口（左闭右开）。
 *
 * - `days = 1` → 今日：`[今日 00:00 JST, 明日 00:00 JST)`
 * - `days = 7` → 含今日的近 7 日：`[6 天前 00:00 JST, 明日 00:00 JST)`
 *
 * @why **右端恒定是"明日 00:00"而不是"此刻"**：统计窗口的右端若取"此刻"，
 *      同一天内每刷新一次数字都在变，且"今日"与"近 7 天"两个窗口的右端会不一致
 *      （一次请求里取了两次时钟的话更是两个值）。右端统一为日界，
 *      "近 7 天"就**严格包含**"今日"，两者可以互相校验（`today ⊆ last7`）。
 * @why 与 `startOfJstDayUtcMinusDays` 同理由放在 shared：服务端业务层禁 `new Date()`
 *      （F10，时钟必须注入），而"日界 + 加减整天"是纯算术。
 * @throws {RangeError} `days` 不是 ≥ 1 的整数——静默把 0 / -1 / 1.5 当成"今天"
 *          会让窗口退化成一段空的或反向的区间，而空区间在统计里的表现是"销售额 0"，
 *          看起来完全合理（空对空假绿灯），必须响亮失败。
 * @limitation 同样按 24 小时整挪（JST 无夏令时，@see 文件头 @limitation）。
 */
export function jstDayWindow(at: Date, days: number): JstDayWindow {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`窗口天数必须是 ≥ 1 的整数，收到 ${String(days)}`);
  }
  const todayStart = startOfJstDayUtc(at);
  return {
    from: new Date(todayStart.getTime() - (days - 1) * 86_400_000),
    to: new Date(todayStart.getTime() + 86_400_000),
  };
}
