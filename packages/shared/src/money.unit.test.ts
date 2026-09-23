/**
 * 职责：Money 值对象与换算/拆分的 L0 单测 + **属性测试**（fast-check）。
 * @why 评审 #5：金额与取整必须"永不差 1 分钱"，靠几条样例测不出来，必须用随机大样本。
 * @why 本文件在外部审查后重写了换算部分：原 `convert()` 用浮点乘法，属性测试只验了"汇率越高结果越大"，
 *      没有和精确值对拍，因此放过了 1250×0.0676 得 84（应为 85）这类边界错误。
 *      现在的属性测试一律与 **BigInt 参考实现**对拍——这是唯一能证明"不差 1 分钱"的方式。
 * @see docs/测试策略与验证门禁.md §6（必测 16）；技术文档 v0.5 §0（×1e8 整数）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addMoney, allocate, money, sumMoney, toMinor, toRateInt } from './money.js';

/** 参考实现：用 BigInt 做精确整数运算（不受 double 精度影响），只用于测试对拍。 */
function referenceToMinor(jpy: number, rateInt: number): number {
  const product = BigInt(jpy) * BigInt(rateInt);
  const divisor = 1_000_000n;
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const q = abs / divisor;
  const r = abs % divisor;
  return Number(sign * (q + (r * 2n >= divisor ? 1n : 0n)));
}

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

  it('同币种相加成功路径', () => {
    expect(addMoney(money(100, 'JPY'), money(250, 'JPY'))).toEqual({
      amount: 350,
      currency: 'JPY',
    });
  });

  it('求和时币种不一致拒绝（静默混算会让总额凭空多出一截）', () => {
    expect(() => sumMoney([money(100, 'JPY'), money(200, 'USD')], 'JPY')).toThrow(TypeError);
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

describe('toRateInt（汇率 ×1e8 整数化）', () => {
  it('小数与 NUMERIC 字符串都转成整数', () => {
    expect(toRateInt(0.00676)).toBe(676_000);
    expect(toRateInt('0.00676')).toBe(676_000); // postgres.js 把 NUMERIC(18,8) 返回成 string
    expect(toRateInt(0.0488)).toBe(4_880_000);
    expect(toRateInt(1)).toBe(100_000_000);
  });

  it('非法与超限汇率拒绝（超限会丢整数精度）', () => {
    expect(() => toRateInt(Number.NaN)).toThrow(RangeError);
    expect(() => toRateInt('abc')).toThrow(RangeError);
    expect(() => toRateInt(2_000_000)).toThrow(RangeError);
  });
});

describe('toMinor（唯一换算入口，整数运算）', () => {
  it('基本换算：¥12,800 → 8653 美分（0.00676）', () => {
    expect(toMinor(12_800, toRateInt(0.00676))).toBe(8653);
  });

  it('曾出错的边界：1250 × 0.0676 — 整数化后是 8450 分（84.50 美元），不再有 half-up 歧义', () => {
    // 旧浮点实现：1250 * 0.0676 = 84.4999… → half-up 得 84（错）。
    // 整数化后：1250 × 6_760_000 = 8,450,000,000；/1e6 = 8450 分，整除无歧义。
    expect(toMinor(1250, toRateInt(0.0676))).toBe(8450);
  });

  it('负数对称（退款方向）', () => {
    const rateInt = toRateInt(0.00676);
    expect(toMinor(-12_800, rateInt)).toBe(-toMinor(12_800, rateInt));
  });

  it('非整数入参与溢出乘积一律拒绝', () => {
    expect(() => toMinor(10.5, 676_000)).toThrow(RangeError);
    expect(() => toMinor(100, 1.5)).toThrow(RangeError);
    expect(() => toMinor(Number.MAX_SAFE_INTEGER, 676_000)).toThrow(RangeError);
  });

  it('属性：与 BigInt 参考实现逐一对拍（金额覆盖到 MAX_ORDER_JPY 之上）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200_000 }), // 覆盖 MAX_ORDER_JPY=180,000 附近
        fc.integer({ min: 1, max: 100_000_000 }), // rateInt：rate ∈ (0, 1]
        (jpy, rateInt) => {
          expect(toMinor(jpy, rateInt)).toBe(referenceToMinor(jpy, rateInt));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('属性：half-up 边界——余数恰为半个除数时进位', () => {
    // rateInt=500_000（rate=0.005），jpy 为奇数时乘积尾数恰为 500_000，正好落在 .5 边界
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }).filter((n) => n % 2 === 1),
        (jpy) => {
          const rateInt = 500_000; // = rate 0.005
          expect(toMinor(jpy, rateInt)).toBe(referenceToMinor(jpy, rateInt));
          // 奇数 × 0.005 → 最小单位是 x.5 分 → half-up 进位，故结果是 (jpy + 1) / 2
          expect(toMinor(jpy, rateInt)).toBe((jpy + 1) / 2);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('allocate（最大余额法拆分）', () => {
  /**
   * 属性：各项之和恒等于总额，绝不差 1 分钱。
   *
   * @limitation 权重全为 0 是**契约外输入**（allocate 会抛 RangeError，见下一条用例），
   *             必须用 `fc.pre` 排除——否则属性测试会把"拒绝非法输入"误报成属性失败，
   *             而且是**偶发**的（实测跑 148 次才撞上一次全零权重），这类红灯最难复现。
   */
  it('属性：各项之和恒等于总额，绝不差 1 分钱', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0)); // 权重和为 0 属非法输入，不在本属性范围内
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

  it('负权重拒绝（N14：负权重会摊出负数项，而和仍等于总额——静默错）', () => {
    expect(() => allocate(100, [-1, 3])).toThrow(RangeError);
    expect(() => allocate(100, [1, -0.5, 1])).toThrow(RangeError);
  });

  it('非整数总额拒绝（N14：0.5 会被 floor 静默抹掉，合计亏 0.5）', () => {
    expect(() => allocate(100.5, [1, 1])).toThrow(RangeError);
    expect(() => allocate(-100.5, [1, 1])).toThrow(RangeError);
  });

  it('负总额合法（退款拆分场景，D18 复核结论），但权重仍不得为负', () => {
    expect(allocate(-100, [1, 3])).toEqual([-25, -75]);
    expect(() => allocate(-100, [-1, 3])).toThrow(RangeError);
  });

  it('非有限权重拒绝（NaN/Infinity 会绕过 sum<=0 检查静默扩散）', () => {
    expect(() => allocate(100, [NaN, 1])).toThrow(RangeError);
    expect(() => allocate(100, [Infinity, 1])).toThrow(RangeError);
  });

  it('含零权重的合法拆分：零权重项分到 0，其余照比例', () => {
    expect(allocate(17, [0, 1])).toEqual([0, 17]);
    expect(allocate(10, [1, 0, 1])).toEqual([5, 0, 5]);
  });
});
