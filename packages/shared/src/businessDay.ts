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
