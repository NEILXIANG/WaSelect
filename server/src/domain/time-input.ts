/**
 * 职责：**管理端时间戳输入**的严格解析（DOM3-03）——契约 `format: date-time` 的可执行形态。
 *
 * @why 原来 `fx-input` 与 `banner-input` 各自 `Date.parse(raw)` 兜底，两处都配着同一句
 *      "毫秒是规范化的 UTC 值，没有时区歧义"。这句话**与实现相反**：
 *      `Date.parse` 对不带偏移的输入（`"2026-10-01T00:00"`）按**本进程时区**解释——
 *      歧义只是从 PG 挪到了 Node：本机（Asia/Shanghai）与 Render（UTC）差 8 小时，
 *      运营意指 JST 零点的汇率在生产上存成 09:00。更糟的是 `Date.parse` 还接受
 *      大量非 RFC 3339 形态：`"1"` → 2001-01-01、`"Oct 1 2026"`、`"2026/10/01"` 全通过，
 *      而契约两处写的都是 `format: date-time`（RFC 3339，**偏移必填**）。
 *
 * @why 抽成一个纯函数而不是在两处各写一遍正则：时区歧义的正确形态只有一种，
 *      两份实现必然漂移（ADR-29：同一个判断的第二份实现就是漂移的起点）。
 *      而且 `Date.parse` 的那句注释正是这么来的——它先被写在一处，再被复制到另一处。
 *
 * @limitation 一：**只认显式偏移**（`Z` 或 `±HH:MM`），不带偏移的本地时间一律拒。
 *      @why "不带偏移"不是一种输入格式，它是一个**待定的约定**（谁的本机时区？），
 *      而约定不该由服务端猜：猜对了没人知道，猜错了隔 8 小时。
 *      admin-web 自己发的都带 `+09:00`（`ops/view.ts` 的 `toIsoJst`），
 *      所以收紧只影响绕过前端直接调接口的调用方（脚本 / curl）。
 * @limitation 二：年份限定 [2000, 2100]。
 *      @why JS 的 Date 能表示 ±27 万年，而 PG 的 timestamptz 下限是公元前 4713 年——
 *      中间那段能过本层、落库时撞 22008（22008 → 50000）。与其让它到库里才炸，
 *      不如在入口用一句"这不像一个业务时间"拒掉。
 * @limitation 三：小数秒最多 6 位（PG timestamptz 的微秒精度）。
 *      @why 多给几位不会报错，但会被**静默截断**——而"静默"正是要消灭的东西。
 *
 * @see contracts/api-contract.yaml（`FxRate.effective_from` 与 `BannerInput.starts_at/ends_at`
 *      都是 `format: date-time`，RFC 3339 偏移必填——本文件是它的可执行形态）；
 *      docs/自主决策记录.md AJ-270；https://datatracker.ietf.org/doc/html/rfc3339#section-5.6
 */
/** RFC 3339：**偏移必填**（`Z` 或 `±HH:MM`）；小数秒 0–6 位。 */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** 业务时间的合理年份区间（见 @limitation 二）。 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * 解析 RFC 3339 时间戳 → UTC 毫秒。
 *
 * @returns UTC 毫秒
 * @throws {RangeError} 不是带显式偏移的 RFC 3339、年份越界、或本身不是一个真实时刻
 *      （如 `2026-02-30T00:00:00Z`——正则只管形状，日历真实性由本函数自校，见下方 @measured）
 */
export function parseRfc3339Ms(raw: string): number {
  const m = RFC3339.exec(raw);
  if (m === null) {
    throw new RangeError(
      `时间戳必须是带显式偏移的 RFC 3339（如 2026-10-01T00:00:00+09:00）：${raw}`,
    );
  }
  const year = Number(m[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new RangeError(`时间戳年份必须在 ${MIN_YEAR}–${MAX_YEAR} 之间：${raw}`);
  }
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  /**
   * ⚠️ 日历真实性**自己判**，不能指望 `Date.parse`（@measured(Node 22, 2026-10-01)：
   * `Date.parse('2026-02-30T00:00:00Z')` 返回 1772409600000，即**静默滚到 3 月 2 日**，
   * 不返回 NaN）。于是"2 月 30 日"会被存成一个真实但**不是调用方想要**的时刻——
   * 这种错在时区类缺陷里最难查：它不报错，只是差两天。
   */
  if (month < 1 || month > 12) throw new RangeError(`月份必须在 01–12：${raw}`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`日期不存在（${year}-${m[2]} 没有这一天）：${raw}`);
  }
  if (hour > 23 || minute > 59 || second > 60) {
    // 60 秒留给闰秒（RFC 3339 允许），其余按钟点范围收
    throw new RangeError(`时分秒超出范围：${raw}`);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new RangeError(`时间戳无法解析：${raw}`);
  return ms;
}

/** 该月的天数（纯算术：闰年 = 能被 4 整除且不能被 100 整除，或能被 400 整除）。 */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2) return leap ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `parseRfc3339Ms` 不抛的版本（调用方要的是"能不能解析"，不是原因）。 */
export function tryParseRfc3339Ms(raw: string): number | null {
  try {
    return parseRfc3339Ms(raw);
  } catch {
    return null;
  }
}
