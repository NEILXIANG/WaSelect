/**
 * 职责：`parseRfc3339Ms` 的用例（DOM3-03）。
 *
 * @why 它替掉的是 `Date.parse`——后者"接受一切"的宽容正是事故来源：
 *      不带偏移的串按**进程时区**解释（本机 JST 与生产 UTC 差 8 小时），
 *      `"1"` 还能被解析成 2001 年。这里要钉的是"什么必须被拒"，
 *      因为"什么被接受"由 `Date.parse` 的性质保证，而"被拒的清单"是我们新加的判断。
 *
 * @limitation 断言一律用**毫秒值**而不是 `new Date(...)`：F10 的纯度规则在
 *             domain 层禁 `new Date`，而且毫秒值才能直接看出"差了 8 小时"。
 */
import { describe, expect, it } from 'vitest';
import { parseRfc3339Ms, tryParseRfc3339Ms } from './time-input.js';

const JST_ZERO = Date.parse('2026-10-01T00:00:00+09:00'); // = 2026-09-30T15:00:00Z

describe('parseRfc3339Ms', () => {
  it('带 Z 与带 ±HH:MM 的偏移都收，且落到同一个时刻', () => {
    expect(parseRfc3339Ms('2026-09-30T15:00:00Z')).toBe(JST_ZERO);
    expect(parseRfc3339Ms('2026-10-01T00:00:00+09:00')).toBe(JST_ZERO);
    expect(parseRfc3339Ms('2026-09-30T15:00:00+00:00')).toBe(JST_ZERO);
  });

  it('小数秒 1–6 位收（PG timestamptz 是微秒精度）', () => {
    expect(parseRfc3339Ms('2026-09-30T15:00:00.5Z')).toBe(JST_ZERO + 500);
    expect(parseRfc3339Ms('2026-09-30T15:00:00.123456Z')).toBe(JST_ZERO + 123);
  });

  it('小写 t / z 也收（RFC 3339 允许，实测上游会这么发）', () => {
    expect(parseRfc3339Ms('2026-09-30t15:00:00z')).toBe(JST_ZERO);
  });

  /**
   * 🔴 本条的主诉：`Date.parse('2026-10-01T00:00')` 在 TZ=UTC 得 00:00Z，
   * 在 TZ=Asia/Shanghai 得 2026-09-30T16:00Z——**同一个输入两种落库结果**。
   */
  it('🔴 不带偏移的本地时间一律拒（DOM3-03：时区歧义必须留在调用方）', () => {
    for (const raw of [
      '2026-10-01T00:00',
      '2026-10-01T00:00:00',
      '2026-10-01 00:00:00',
      '2026-10-01',
    ]) {
      expect(() => parseRfc3339Ms(raw)).toThrow(RangeError);
      expect(tryParseRfc3339Ms(raw)).toBeNull();
    }
  });

  it('🔴 `Date.parse` 那几种"意外接受"的串一律拒', () => {
    for (const raw of ['1', 'Oct 1 2026', '2026/10/01', 'now', '2026-10-01T00:00:00+0900']) {
      expect(() => parseRfc3339Ms(raw)).toThrow(RangeError);
    }
  });

  it('🔴 年份越界拒（JS 能表示 ±27 万年，PG timestamptz 到不了 → 落库 22008）', () => {
    expect(() => parseRfc3339Ms('1999-12-31T23:59:59Z')).toThrow(RangeError);
    expect(() => parseRfc3339Ms('2101-01-01T00:00:00Z')).toThrow(RangeError);
    expect(parseRfc3339Ms('2000-01-01T00:00:00Z')).toBe(Date.parse('2000-01-01T00:00:00Z'));
    expect(parseRfc3339Ms('2100-12-31T23:59:59Z')).toBe(Date.parse('2100-12-31T23:59:59Z'));
  });

  it('小数秒超过 6 位拒（多给的位会被库静默截断）', () => {
    expect(() => parseRfc3339Ms('2026-09-30T15:00:00.1234567Z')).toThrow(RangeError);
  });

  it('形状合法但日历上不存在的时刻也拒（正则只管形状）', () => {
    expect(() => parseRfc3339Ms('2026-02-30T00:00:00Z')).toThrow(RangeError);
    expect(() => parseRfc3339Ms('2026-13-01T00:00:00Z')).toThrow(RangeError);
  });
});
