/**
 * 职责：JST 业务日的 L0 单测（偏移边界 / 跨日 / 属性：同一天内 start 相同）。
 * @see docs/地基搭建清单.md F2b
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  isSameJstDay,
  jstDate,
  jstDateCompact,
  jstDayWindow,
  shipOverdueCutoff,
  startOfJstDayUtc,
  startOfJstDayUtcMinusDays,
  toJstParts,
} from './businessDay.js';

describe('JST 偏移', () => {
  it('UTC 15:00 = 次日 JST 00:00（跨日边界）', () => {
    const at = new Date('2026-09-21T15:00:00Z');
    expect(jstDate(at)).toBe('2026-09-22');
    const p = toJstParts(at);
    expect(p).toMatchObject({ year: 2026, month: 9, day: 22, hour: 0, minute: 0 });
  });

  it('UTC 14:59 仍属 JST 当日', () => {
    expect(jstDate(new Date('2026-09-21T14:59:59Z'))).toBe('2026-09-21');
  });

  it('紧凑串用于订单号', () => {
    expect(jstDateCompact(new Date('2026-09-21T15:00:00Z'))).toBe('20260922');
  });
});

describe('startOfJstDayUtc', () => {
  it('同一 JST 日内的任意时刻，起始时刻相同', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
        fc.integer({ min: 0, max: 86_399 }),
        (dayStart, offsetSec) => {
          const a = new Date(dayStart + offsetSec * 1000);
          const b = new Date(dayStart + (offsetSec % 3600) * 1000);
          if (!isSameJstDay(a, b)) return; // 不在同一 JST 日则跳过比较
          expect(startOfJstDayUtc(a).getTime()).toBe(startOfJstDayUtc(b).getTime());
        },
      ),
      { numRuns: 200 },
    );
  });

  it('起始时刻回推的 JST 日期不变（幂等）', () => {
    const at = new Date('2026-09-22T03:21:00Z');
    expect(jstDate(startOfJstDayUtc(at))).toBe(jstDate(at));
  });
});

/**
 * `startOfJstDayUtcMinusDays`（工作台的"近 N 天"窗口起点）。
 * @why 单独一组：它是**统计口径的地基**——窗口起点错一天，"近 7 天销售额"就是错的，
 *      而这种错**不会报错**（数字看起来很合理），只能靠边界用例钉住。
 */
describe('startOfJstDayUtcMinusDays（近 N 日窗口起点）', () => {
  it('days=0 等于当日起点', () => {
    const at = new Date('2026-10-08T03:21:00Z'); // JST 10-08 12:21
    expect(startOfJstDayUtcMinusDays(at, 0).toISOString()).toBe(startOfJstDayUtc(at).toISOString());
  });

  it('🔴 往前推 6 天 = 含当日在内的 7 日窗口，起点仍是 JST 00:00', () => {
    const at = new Date('2026-10-08T03:21:00Z'); // JST 10-08
    const from = startOfJstDayUtcMinusDays(at, 6);
    // JST 10-02 00:00 = UTC 10-01 15:00
    expect(from.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(jstDate(from)).toBe('2026-10-02');
  });

  it('🔴 跨月 / 跨年照样按 JST 日历走（不是简单的 UTC 减 24h×N）', () => {
    // JST 2026-03-01 12:00（UTC 2026-03-01 03:00）
    const at = new Date('2026-03-01T03:00:00Z');
    expect(jstDate(at)).toBe('2026-03-01');
    const from = startOfJstDayUtcMinusDays(at, 2);
    // JST 02-27 00:00 = UTC 02-26 15:00
    expect(from.toISOString()).toBe('2026-02-26T15:00:00.000Z');
    expect(jstDate(from)).toBe('2026-02-27');
  });

  it('属性：同一 JST 日内的任意时刻，推 N 天得到同一个起点', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 2), max: Date.UTC(2027, 0, 1) }),
        fc.integer({ min: 0, max: 86_399 }),
        fc.integer({ min: 0, max: 30 }),
        (dayStart, offsetSec, days) => {
          const a = new Date(dayStart + offsetSec * 1000);
          if (jstDate(a) !== jstDate(new Date(dayStart))) return;
          expect(startOfJstDayUtcMinusDays(a, days).getTime()).toBe(
            startOfJstDayUtcMinusDays(new Date(dayStart), days).getTime(),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * `jstDayWindow`（工作台"今日 / 近 7 天"两个窗口的唯一出处）。
 *
 * @why 单独一组：左闭右开 + "右端恒为明日日界"这两条约定一旦写错，
 *      表现是"今日销售额 + 前 6 天 ≠ 近 7 天销售额"——没人会收到报错，
 *      只会觉得"数字好像不太对"。这里用包含关系把它钉死。
 */
describe('jstDayWindow（含当日的 N 日窗口，左闭右开）', () => {
  it('days = 1 → 今日窗口，两端都是 JST 日界', () => {
    const at = new Date('2026-10-08T03:21:00Z'); // JST 10-08 12:21
    const w = jstDayWindow(at, 1);
    expect(w.from.toISOString()).toBe('2026-10-07T15:00:00.000Z'); // JST 10-08 00:00
    expect(w.to.toISOString()).toBe('2026-10-08T15:00:00.000Z'); // JST 10-09 00:00
  });

  it('🔴 右端恒为"明日 00:00"，与"此刻"无关（同一天内刷新数字不变）', () => {
    const early = new Date('2026-10-07T15:00:00.000Z'); // JST 10-08 00:00
    const late = new Date('2026-10-08T14:59:59.999Z'); // JST 10-08 23:59:59.999
    expect(jstDayWindow(early, 1).to.getTime()).toBe(jstDayWindow(late, 1).to.getTime());
    expect(jstDayWindow(early, 1).from.getTime()).toBe(jstDayWindow(late, 1).from.getTime());
  });

  it('🔴 days = 7 → 恰好 7 个自然日，且**严格包含**今日窗口', () => {
    const at = new Date('2026-10-08T03:21:00Z');
    const today = jstDayWindow(at, 1);
    const last7 = jstDayWindow(at, 7);
    expect(last7.to.getTime()).toBe(today.to.getTime()); // 右端相同
    expect(last7.from.toISOString()).toBe('2026-10-01T15:00:00.000Z'); // JST 10-02 00:00
    expect(last7.to.getTime() - last7.from.getTime()).toBe(7 * 86_400_000);
    // 包含关系：今日 ⊆ 近 7 天
    expect(last7.from.getTime()).toBeLessThan(today.from.getTime());
  });

  it('🔴 天数非法必须响亮失败（0 / 负 / 小数都不静默退化成"今天"）', () => {
    const at = new Date('2026-10-08T03:21:00Z');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => jstDayWindow(at, bad)).toThrow(RangeError);
    }
  });

  it('属性：任意 days ≥ 1，窗口长度恒为 days 天且右端对齐日界', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 1, 1), max: Date.UTC(2027, 0, 1) }),
        fc.integer({ min: 1, max: 30 }),
        (ms, days) => {
          const w = jstDayWindow(new Date(ms), days);
          expect(w.to.getTime() - w.from.getTime()).toBe(days * 86_400_000);
          // 两端都必须是某个 JST 日的 00:00（startOfJstDayUtc 幂等）
          expect(startOfJstDayUtc(w.from).getTime()).toBe(w.from.getTime());
          expect(startOfJstDayUtc(w.to).getTime()).toBe(w.to.getTime());
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * 超时未发货的截止（三端模拟测试 2026-10-11，AJ-484）：付款日之后第 N 个工作日（JST 周一至周五）当天结束前要发出，
 * 之后仍未发就是超时。`shipOverdueCutoff(now, N)` = 一个时刻：付款早于它的待发货单已超时。
 * 2026-10-05 是周一（JST）。
 */
describe('shipOverdueCutoff（超时未发货的截止，JST 工作日）', () => {
  const jst = (s: string): Date => new Date(`${s}+09:00`);
  const overdue = (paid: string, now: string, n = 7): boolean =>
    jst(paid).getTime() < shipOverdueCutoff(jst(now), n).getTime();

  it('🔴 周一付款、7 个工作日：截止是下周三当天，周四起超时', () => {
    expect(overdue('2026-10-05T10:00:00', '2026-10-14T23:59:00')).toBe(false); // 下周三
    expect(overdue('2026-10-05T10:00:00', '2026-10-15T00:01:00')).toBe(true); // 下周四
  });

  it('🔴 周六付款：周末不算，截止是第 2 周的周二，周三起超时', () => {
    expect(overdue('2026-10-10T15:00:00', '2026-10-20T20:00:00')).toBe(false); // 周二
    expect(overdue('2026-10-10T15:00:00', '2026-10-21T08:00:00')).toBe(true); // 周三
  });

  it('今天是周末：不会因为周末多算出超时（周五截止的单，周六周日仍算在周五之后一天）', () => {
    // 周四（10-08）付款 → 截止 10-19（周一）
    expect(overdue('2026-10-08T09:00:00', '2026-10-17T12:00:00')).toBe(false); // 周六
    expect(overdue('2026-10-08T09:00:00', '2026-10-19T23:00:00')).toBe(false); // 周一当天
    expect(overdue('2026-10-08T09:00:00', '2026-10-20T00:30:00')).toBe(true); // 周二
  });

  it('跨 JST 日界：JST 周一 00:30 付款（UTC 仍是周日）按 JST 周一算', () => {
    expect(overdue('2026-10-05T00:30:00', '2026-10-14T23:00:00')).toBe(false);
    expect(overdue('2026-10-05T00:30:00', '2026-10-15T00:10:00')).toBe(true);
  });

  it('N 不是 ≥ 1 的整数 → 抛错（静默当成 0 会把所有待发货单都算超时）', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expect(() => shipOverdueCutoff(jst('2026-10-15T10:00:00'), n), String(n)).toThrow(RangeError);
    }
  });
});
