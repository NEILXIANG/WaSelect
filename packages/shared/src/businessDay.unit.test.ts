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
  startOfJstDayUtc,
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
