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
import {
  addMoney,
  allocate,
  applyRate,
  money,
  sumMoney,
  toMinor,
  toRateInt,
  toRatioInt,
} from './money.js';

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
    // 边界恰好值（审查 2026-10-09 C5）：判定是 `>=`，1_000_000 必拒、999_999 必收——`>` 写法在这两点上红
    expect(() => toRateInt(1_000_000)).toThrow(RangeError);
    expect(toRateInt(999_999)).toBe(99_999_900_000_000);
  });

  /**
   * 三审 P3-6：0 与负汇率必须在**唯一换算入口**被拒。`toRateInt(0)` → 0，`toMinor(180000, 0)` → 0：
   * 一条坏汇率行（管理员误填 0 / 负数）会让全站按 0 元收款，而 `money()` 只看整数性。
   */
  it('0 与负汇率拒绝（一条坏汇率行不能让全站按 0 元收款）', () => {
    expect(() => toRateInt(0)).toThrow(RangeError);
    expect(() => toRateInt('0')).toThrow(RangeError);
    expect(() => toRateInt(-0.00676)).toThrow(RangeError);
  });

  /**
   * 🔴 DOM3-04：`n <= 0` 那条守的是**小数域**，而下游用的是**整数化之后**的值。
   * `0 < rate < 5e-9` 在小数域里是正数，×1e8 取整后却是 0——正是这条防线声称要消灭的
   * "全站按 0 元收款"。所以判定必须发生在取整之后。
   */
  it('🔴 正但整数化后为 0 的汇率同样拒绝（判定在取整之后，DOM3-04）', () => {
    expect(() => toRateInt(4e-9)).toThrow(RangeError);
    expect(() => toRateInt('0.000000004')).toThrow(RangeError);
    expect(() => toRateInt(4.99e-9)).toThrow(RangeError);
    // 边界：5e-9 取整得 1（half-up），仍然通过——下界是"整数化后 > 0"，不是拍一个小数下界
    expect(toRateInt(5e-9)).toBe(1);
    expect(toRateInt(1e-8)).toBe(1); // NUMERIC(18,8) 的最小正值
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

/**
 * 最大余额法的"按比例"不变量：每项与精确份额 `total × w / Σw` 相差**小于 1**（只差一次取整）。
 * @why 只验"和等于总额"挡不住"和对、分错"的缺陷——把余数全堆到第一项、甚至整笔给第一项，和照样对；
 *      退款拆分里那就是"这件商品多退、那件少退"，对账层也看不出来（2026-10-09 审计 WorkBuddy 补丁时补上）。
 */
function expectProportional(
  parts: readonly number[],
  total: number,
  weights: readonly number[],
): void {
  const sum = weights.reduce((a, b) => a + b, 0);
  parts.forEach((p, i) => {
    const exact = (total * (weights[i] ?? 0)) / sum;
    expect(Math.abs(p - exact), `第 ${i} 项 ${p} 偏离精确份额 ${exact}`).toBeLessThan(1);
  });
}

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
          expectProportional(parts, total, weights);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * 🔴 负总额（退款拆分）的同一不变量：`allocate` 声明负总额合法（文件头 @why / D18），
   *    但"各项之和恒等于总额"这条最资损的不变量此前只 fuzz 正总额——负路径只有两个固定用例在守。
   *    若有人在负数分支引入 off-by-one（remainder 进位判定在负数下出错），上面的正总额属性测试不会红。
   *    这里补上负总额的随机对拍：和仍恒等于总额、每项仍为整数。
   * @limitation 负总额下各项也必须为整数，但**符号**随总额（同为负）——只断言"和等于总额"即可，
   *             不额外断言每项正负，避免与实现的舍入方向细节耦合。
   */
  it('属性：负总额（退款拆分）各项之和同样恒等于总额', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000_000, max: -1 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const parts = allocate(total, weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          expect(parts).toHaveLength(weights.length);
          for (const p of parts) expect(Number.isInteger(p)).toBe(true);
          // 负总额下每项都不该产出 -0（与 applyRate / toMinor 同口径，DOM3-06③）
          for (const p of parts) expect(Object.is(p, -0)).toBe(false);
          expectProportional(parts, total, weights);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('总额为 0：各项都是 0（不是 -0），长度不变', () => {
    expect(allocate(0, [3, 0, 7])).toEqual([0, 0, 0]);
    for (const p of allocate(0, [1, 2])) expect(Object.is(p, -0)).toBe(false);
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

  /**
   * 🔴 DOM3-06③：`Math.floor(-0) = -0`，负总额 + 零权重项会产出 `-0`。
   * @why -0 与 0 在 `===` 下相等、`Object.is` 下不等：进 JSON 是 0、进日志是 0，
   *      但任何"按符号分支"的消费者会分叉。本文件 `applyRate` / `toMinor` 都已归一，
   *      只有 `allocate` 漏了——同文件两种口径是最容易复发的一种不一致。
   */
  it('🔴 负总额不产出 -0（与 applyRate / toMinor 同一口径，DOM3-06③）', () => {
    const parts = allocate(-5, [0, 1]);
    // ⚠️ 只能用 `Object.is` 判：`===` 与 `toEqual` 都把 -0 当 0，断言会假绿
    expect(Object.is(parts[0], -0)).toBe(false);
    expect(parts.every((v) => !Object.is(v, -0))).toBe(true);
    // 和仍等于总额（归一不能改变分摊结果）
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-5);
  });
});

describe('toRatioInt（无量纲比率 → ×1e8 整数）', () => {
  it('NUMERIC(6,5) 驱动返回的字符串与 number 等价', () => {
    expect(toRatioInt('0.15000')).toBe(15_000_000);
    expect(toRatioInt(0.15)).toBe(15_000_000);
  });

  it('0 合法（零关税是正常业务，与汇率的 0 是事故不同）', () => {
    expect(toRatioInt(0)).toBe(0);
    expect(toRatioInt('0.00000')).toBe(0);
  });

  it('负数 / 非有限数 / 超范围一律 RangeError', () => {
    expect(() => toRatioInt(-0.01)).toThrow(RangeError);
    expect(() => toRatioInt(NaN)).toThrow(RangeError);
    expect(() => toRatioInt('abc')).toThrow(RangeError);
    expect(() => toRatioInt(1_000_000)).toThrow(RangeError);
  });
});

describe('applyRate（同币种乘率，half-up）', () => {
  /** BigInt 参考实现（与 referenceToMinor 同套路，只是除数为 1e8）。 */
  function referenceApplyRate(amount: number, ratioInt: number): number {
    const product = BigInt(amount) * BigInt(ratioInt);
    const divisor = 100_000_000n;
    const sign = product < 0n ? -1n : 1n;
    const abs = product < 0n ? -product : product;
    const q = abs / divisor;
    const r = abs % divisor;
    return Number(sign * (r * 2n >= divisor ? q + 1n : q));
  }

  it('duty 典型值：10,000 円 × 15% = 1,500 円', () => {
    expect(applyRate(10_000, toRatioInt('0.15000'))).toBe(1500);
  });

  it('0 比率 → 0（零关税不该抛错）', () => {
    expect(applyRate(10_000, 0)).toBe(0);
  });

  it('half-up 边界：0.5 进位、0.49 舍去、负金额远离零', () => {
    expect(applyRate(1, toRatioInt(0.5))).toBe(1); // 0.5 → 1
    expect(applyRate(100, toRatioInt('0.00499'))).toBe(0); // 0.499 → 0
    expect(applyRate(-1, toRatioInt(0.5))).toBe(-1); // -0.5 → -1（远离零，与 toMinor 同）
  });

  it('负金额小额乘率不得产出 -0（Object.is 可区分，本属性测试实抓过一次）', () => {
    expect(Object.is(applyRate(-1, 1), 0)).toBe(true);
    expect(Object.is(toMinor(-1, 1), 0)).toBe(true);
  });

  it('非法输入：非整数金额 / 非整数比率 / 负比率', () => {
    expect(() => applyRate(1.5, 100)).toThrow(RangeError);
    expect(() => applyRate(100, 1.5)).toThrow(RangeError);
    expect(() => applyRate(100, -1)).toThrow(RangeError);
  });

  it('乘积超出 2^53 → RangeError（不接受静默失精的"差不多"金额）', () => {
    expect(() => applyRate(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it('属性：全值域与 BigInt 参考实现一致（永不差 1 円）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        // duty_rates CHECK 是 [0,1)；放宽到 [0,2) 留出将来"费率 >1"的余量
        fc.integer({ min: 0, max: 200_000_000 }),
        (amount, ratioInt) => {
          expect(applyRate(amount, ratioInt)).toBe(referenceApplyRate(amount, ratioInt));
        },
      ),
      { numRuns: 500 },
    );
  });
});
