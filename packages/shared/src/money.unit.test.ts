/**
 * 职责：Money 值对象与取整/拆分的 L0 单测 + **属性测试**（fast-check）。
 * @why 评审 #5：金额与取整必须"永不差 1 分钱"，靠几条样例测不出来，必须用随机大样本。
 * @see docs/测试策略与验证门禁.md §6（必测 16）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addMoney, allocate, convert, money, sumMoney } from './money.js';

describe('Money 构造与运算', () => {
  it('非整数 / 非法数值一律拒绝（把脏数据挡在边界）', () => {
    expect(() => money(10.5, 'JPY')).toThrow(RangeError);
    expect(() => money(Number.NaN, 'JPY')).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY, 'JPY')).toThrow(RangeError);
    expect(money(0, 'JPY')).toEqual({ amount: 0, currency: 'JPY' });
  });

  it('跨币种相加被禁止（禁止隐式换算）', () => {
    expect(() => addMoney(money(100, 'JPY'), money(100, 'USD'))).toThrow(TypeError);
  });

  it('求和满足交换律与结合律', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 20 }),
        (amounts) => {
          const items = amounts.map((a) => money(a, 'JPY'));
          const total = sumMoney(items, 'JPY').amount;
          const reversed = sumMoney([...items].reverse(), 'JPY').amount;
          const expected = amounts.reduce((a, b) => a + b, 0);
          expect(total).toBe(expected);
          expect(reversed).toBe(total);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('convert（唯一取整入口）', () => {
  it('结果恒为整数，且 half-up（0.5 向上）', () => {
    expect(convert(100, 0.005)).toBe(1); // 0.5 → 1
    expect(convert(100, 0.004)).toBe(0); // 0.4 → 0
    expect(convert(0, 0.0067)).toBe(0);
  });

  it('属性：任意金额与汇率，输出都是整数；汇率单调 ⇒ 结果单调不减', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        (amount, rate) => {
          const out = convert(amount, rate);
          expect(Number.isInteger(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(0);
          expect(convert(amount, rate + 0.001)).toBeGreaterThanOrEqual(out);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('allocate（最大余额法拆分）', () => {
  it('属性：各项之和恒等于总额，绝不差 1 分钱', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const parts = allocate(total, weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          expect(parts).toHaveLength(weights.length);
          for (const p of parts) expect(Number.isInteger(p)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('权重之和为 0 时拒绝（避免除零产生 NaN 静默扩散）', () => {
    expect(() => allocate(100, [0, 0])).toThrow(RangeError);
  });
});
