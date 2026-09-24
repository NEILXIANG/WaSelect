/**
 * 职责：订单号的 L0 单测 + 属性测试（F2b）。
 * @why 审查后重写：原实现是 `W`+YYYYMMDD+自增序号（与文档 §1 冲突，且"禁止自增"是硬口径），
 *      并且有一个溢出撞号缺陷——`encodeSeq(32⁶)` 与 `encodeSeq(0)` 都返回 `000000`，
 *      而当时的属性测试取值 `max: 32**6 - 1`，**恰好停在边界内侧**绕开了它。
 *      教训写在这里：属性测试的取值区间必须**跨越**边界，而不是贴着边界。
 * @see 技术文档 v0.5 §1（单号口径）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { jstDateShort } from './businessDay.js';
import {
  formatOrderNo,
  isValidOrderNo,
  ORDER_NO_PATTERN,
  parseOrderNoDate,
  randomOrderSeq,
} from './orderNo.js';

/** 确定性随机源（mulberry32），让"随机段"测试可复现、无偶发。 */
function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('格式（与技术文档 §1 逐字对齐）', () => {
  it('YYMMDD-6位随机段，总长 13（DB 上限 20）', () => {
    const no = formatOrderNo('260919', 'K7Q2MN');
    expect(no).toBe('260919-K7Q2MN');
    expect(no).toHaveLength(13);
    expect(no.length).toBeLessThanOrEqual(20);
  });

  /**
   * 规范示例**自己**必须过得了校验。
   *
   * @why 2026-09-24 实测发现：`orderNo.ts` / `businessDay.ts` 的注释与技术文档里的
   *      示例写的是 `260919-K7Q2ML`，而 `L` 是 Crockford 字母表**排除**的字符——
   *      也就是说"规范示例"会被 `formatOrderNo` 抛 RangeError 拒绝。
   *      照抄文档的人会拿到一个永远无法入库的单号，而报错指向数据、不指向文档。
   *      这类漂移不会让任何测试变红（注释不是代码），只能靠一条显式用例钉住。
   * @limitation 只能钉住**这个**示例串；新增文档里的新示例要自觉加到这里。
   */
  it('注释与技术文档引用的规范示例本身必须合法（防"示例自己过不了校验"）', () => {
    const docExample = '260919-K7Q2MN';
    expect(isValidOrderNo(docExample)).toBe(true);
    expect(parseOrderNoDate(docExample)).toBe('260919');
    // 反面：历史错误示例（含 L）仍须被拒——保证"改示例"不是靠放宽规则实现的
    expect(isValidOrderNo('260919-K7Q2ML')).toBe(false);
  });

  it('文档示例的反面：不接受 W 前缀与 4 位年份', () => {
    expect(isValidOrderNo('W20260922-000001')).toBe(false);
    expect(isValidOrderNo('20260922-K7Q2MN')).toBe(false);
    expect(isValidOrderNo('260919-K7Q2MN')).toBe(true);
  });

  it('非法日期段 / 随机段被拒绝（含 Crockford 排除字符 I L O U）', () => {
    expect(() => formatOrderNo('20260922', 'K7Q2MN')).toThrow(RangeError);
    expect(() => formatOrderNo('260919', 'K7Q2M')).toThrow(RangeError);
    expect(() => formatOrderNo('260919', 'K7Q2MI')).toThrow(RangeError); // 含 I
    expect(() => formatOrderNo('260919', 'K7Q2ML')).toThrow(RangeError); // 含 L（Crockford 排除，易与 1 混）
    expect(() => formatOrderNo('260919', 'K7Q2MO')).toThrow(RangeError); // 含 O（易与 0 混）
    expect(() => formatOrderNo('260919', 'k7q2ml')).toThrow(RangeError); // 小写
  });
});

describe('randomOrderSeq（禁止自增：必须是随机段）', () => {
  it('属性：任意随机源都产出 6 位合法字符', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 }), (seed) => {
        const seq = randomOrderSeq(seededRand(seed));
        expect(seq).toHaveLength(6);
        expect(seq).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      }),
      { numRuns: 500 },
    );
  });

  it('一万个种子无重复（确定性，不会偶发失败）', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 10_000; seed += 1) seen.add(randomOrderSeq(seededRand(seed)));
    expect(seen.size).toBe(10_000);
  });

  it('连续生成不是递增关系——自增会暴露日单量且可被枚举', () => {
    const rand = seededRand(42);
    const a = randomOrderSeq(rand);
    const b = randomOrderSeq(rand);
    expect(a).not.toBe(b);
    // 自增实现的特征是"后一个 = 前一个 + 1"；这里断言解码后的数值不相邻
    const decode = (s: string) =>
      [...s].reduce((acc, c) => acc * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c), 0);
    expect(Math.abs(decode(b) - decode(a))).not.toBe(1);
  });
});

describe('parse / isValid', () => {
  it('属性：任意合法日期 + 随机段都能解析回原日期', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 1, max: 2 ** 31 }),
        (dateNum, seed) => {
          const yymmdd = String(dateNum).padStart(6, '0');
          const no = formatOrderNo(yymmdd, randomOrderSeq(seededRand(seed)));
          expect(parseOrderNoDate(no)).toBe(yymmdd);
          expect(isValidOrderNo(no)).toBe(true);
          expect(ORDER_NO_PATTERN.test(no)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('非法单号返回 undefined / false，不抛错', () => {
    expect(parseOrderNoDate('X260919-K7Q2MN')).toBeUndefined();
    expect(parseOrderNoDate('')).toBeUndefined();
    expect(isValidOrderNo('')).toBe(false);
  });
});

describe('jstDateShort（订单号日期段）', () => {
  it('取 JST 日期的 YYMMDD', () => {
    // UTC 2026-09-22T15:00Z → JST 2026-09-23 00:00
    expect(jstDateShort(new Date('2026-09-22T15:00:00Z'))).toBe('260923');
  });

  it('跨 JST 日界：UTC 14:59 仍属前一日', () => {
    expect(jstDateShort(new Date('2026-09-22T14:59:00Z'))).toBe('260922');
  });
});
