/**
 * 职责：`domain/fx-input.ts` 的单测（I2 U-C1）。
 *
 * @why 每个约束都给「错值」与「对值」两个用例（CLAUDE.md 七项完成标准）：
 *      只测通过值的话，"把校验整段删掉"也能绿——校验的存在性必须由
 *      "某个值被拒绝"来证明，而不是由"某个值被接受"来证明。
 *
 * @why `applyFxBuffer` 的结果直接对 `toRateInt` 做交叉验证：
 *      本函数的产出**只**被 toRateInt 消费（domain/quote.ts 经它算展示价）。
 *      两个模块各测各的，接缝处谁也不管——而接缝正是"两次舍入"会出错的地方。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { applyFxBuffer, FX_QUOTES, parseFxInput } from './fx-input.js';
import { toRateInt } from '@waselect/shared';

/** 取错误码（非 AppError 直接抛出，避免"没抛错也绿"）。 */
function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

describe('parseFxInput', () => {
  it('body 不是对象 → 40001', () => {
    expect(codeOf(() => parseFxInput(null))).toBe(40001);
    expect(codeOf(() => parseFxInput('x'))).toBe(40001);
  });

  it('quote 缺失或不在枚举内 → 40001（JPY 是定价锚，没有展示汇率入口）', () => {
    expect(codeOf(() => parseFxInput({ raw_rate: 0.0065 }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'JPY', raw_rate: 1 }))).toBe(40001);
    // 小写不放松：enum 是契约面的事实，大小写变异等于新增一个未登记的值
    expect(codeOf(() => parseFxInput({ quote: 'usd', raw_rate: 0.0065 }))).toBe(40001);
  });

  it('raw_rate 缺失 / 非有限数 / ≤0 → 40001', () => {
    expect(codeOf(() => parseFxInput({ quote: 'USD' }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: '0.0065' }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: Number.NaN }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0 }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: -0.0065 }))).toBe(40001);
  });

  it('raw_rate 超出量纲上限 → 40001（防"多打几个 0"）', () => {
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 1001 }))).toBe(40001);
    // 上限本身是合法边界内：不要求"必须小于 1"，否则量纲正确的 KRW 之类会被误伤
    expect(parseFxInput({ quote: 'USD', raw_rate: 1000 }).rawRate).toBe(1000);
  });

  /**
   * B25 / AJ-211：**"正得离谱"和"≤0"是两种不同的录入错误**，都要挡。
   *
   * @why `rawRate > 0` 挡不住这一半：`applyFxBuffer` 会把值对齐到 1e-8 的网格，
   *      小于 `0.5/1e8`（5×10⁻⁹）的正数一律**舍成 0** ⇒ `toRateInt(0)` 抛错 ⇒
   *      保存汇率这条管理端写路径 500，之后每次读商品列表都撞上这个 0 汇率。
   *      @why 只断言"被拒"是不够的——把下界删掉之后，`rawRate=1e-12` 会通过解析，
   *      而落库时才炸（在另一个模块）；所以这里必须**用小到会舍成 0 的值**当输入。
   */
  it('raw_rate 小到会被网格舍成 0 → 40001 raw_rate_too_small（B25 / AJ-211）', () => {
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 1e-12 }))).toBe(40001);
    expect(codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 4.9e-9 }))).toBe(40001);
    // 刚好能活下来的边界仍通过（1e-8 > 0.5/1e8）
    expect(parseFxInput({ quote: 'USD', raw_rate: 1e-8 }).rawRate).toBe(1e-8);
  });

  it('effective_from 非法日期 → 40001；缺省 → null（调用方填 clock.now()）', () => {
    expect(
      codeOf(() => parseFxInput({ quote: 'USD', raw_rate: 0.0065, effective_from: 'x' })),
    ).toBe(40001);
    expect(parseFxInput({ quote: 'USD', raw_rate: 0.0065 }).effectiveFromMs).toBeNull();
  });

  it('合法输入：两币都收，effective_from 解析成 UTC 毫秒（带偏移也归一）', () => {
    const expectMs = Date.parse('2026-09-28T00:00:00Z');
    for (const q of FX_QUOTES) {
      const v = parseFxInput({
        quote: q,
        raw_rate: 0.0065,
        effective_from: '2026-09-28T00:00:00Z',
      });
      expect(v.quote).toBe(q);
      expect(v.effectiveFromMs).toBe(expectMs);
    }
    // JST 同一时刻：前端 toIsoJst 钉成 +09:00，两种写法必须落到同一毫秒
    expect(
      parseFxInput({
        quote: 'USD',
        raw_rate: 1,
        effective_from: '2026-09-28T09:00:00+09:00',
      }).effectiveFromMs,
    ).toBe(expectMs);
  });
});

describe('applyFxBuffer', () => {
  it('rate = raw × (1 + buffer)', () => {
    expect(applyFxBuffer(0.0065, 0.03)).toBe(0.006695);
    expect(applyFxBuffer(100, 0)).toBe(100);
  });

  it('结果落在 1e-8 网格上：与 toRateInt 的舍入只发生一次', () => {
    // 0.0065 × 1.03 在 double 里带浮点尾巴；不先对齐的话 rate 与 rateInt 会各自舍入一次
    const rate = applyFxBuffer(0.0065, 0.03);
    expect(rate * 1e8).toBe(Math.round(rate * 1e8));
    expect(toRateInt(rate)).toBe(669500);
  });
});
