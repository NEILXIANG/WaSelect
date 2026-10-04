/**
 * 职责：`domain/shipping-rates-input.ts` 的单测（I2 U-C1）。
 *
 * @why **整表**层面的三条约束（非空 / 唯一键 / 活跃承运商恰好一家）各给独立用例：
 *      它们是"单条全对、整表仍然错"的那类问题，而 `PUT /admin/shipping-rates`
 *      是整表替换——单条校验再严也挡不住它们。
 *      其中"活跃承运商恰好一家"是 D-46 同源的静默事故：违反后全站报价 50004。
 *
 * @limitation 只测纯校验；"替换后是不是真的能取到档"由仓储与路由的接线级用例证明。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseShippingRates } from './shipping-rates-input.js';

function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

/**
 * 取 `details.reason`。
 * @why **必须**断言 reason 而不只是错误码：空表（`rates_empty`）与全停用（`no_active_tier`）
 *      是两条独立守卫，但都抛 40001——只断言码的话，注入"去掉空表守卫"仍然全绿
 *      （被后一条兜住），缺陷注入第一次就没变红。这正是"两个守卫覆盖同一输入"的
 *      覆盖假象（§2 教训：断言不够特异 = 没断言）。reason 进日志，是排障时的唯一线索，
 *      所以它本身就是被验证的行为，不是实现细节。
 */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return String((e.details as { reason?: unknown })?.reason ?? '');
    throw e;
  }
  throw new Error('预期抛 AppError，实际没有抛');
}

const OK = [
  { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2100 },
  { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4950 },
];

describe('parseShippingRates', () => {
  it('非数组 / 空数组 → 40001（空表 = 全站无法报价）', () => {
    expect(codeOf(() => parseShippingRates({}))).toBe(40001);
    expect(codeOf(() => parseShippingRates([]))).toBe(40001);
    // reason 必须与"全停用"区分：两条守卫都是 40001，只有 reason 能证明是这一条拦的
    expect(reasonOf(() => parseShippingRates([]))).toBe('rates_empty');
  });

  it('元素不是对象 → 40001', () => {
    expect(codeOf(() => parseShippingRates([null]))).toBe(40001);
  });

  it('carrier 空或超 32 字符 → 40001（列宽 VARCHAR(32)）', () => {
    expect(codeOf(() => parseShippingRates([{ ...OK[0], carrier: '  ' }]))).toBe(40001);
    expect(codeOf(() => parseShippingRates([{ ...OK[0], carrier: 'c'.repeat(33) }]))).toBe(40001);
  });

  it('max_weight_g 非整数或 <1 → 40001；price_jpy 非整数或 <0 → 40001', () => {
    expect(codeOf(() => parseShippingRates([{ ...OK[0], max_weight_g: 0 }]))).toBe(40001);
    expect(codeOf(() => parseShippingRates([{ ...OK[0], max_weight_g: 1.5 }]))).toBe(40001);
    expect(codeOf(() => parseShippingRates([{ ...OK[0], price_jpy: -1 }]))).toBe(40001);
    expect(codeOf(() => parseShippingRates([{ ...OK[0], price_jpy: 1.5 }]))).toBe(40001);
    // 0 円运费合法（手动包邮），不是事故
    expect(parseShippingRates([{ ...OK[0], price_jpy: 0 }])[0]?.priceJpy).toBe(0);
  });

  /**
   * AJ-297：绝对量纲上界（30kg / 10万円）。
   *
   * @why 断言的是 **reason** 而不只是错误码：`max_weight_g_invalid`（不是整数）
   *      与 `max_weight_g_out_of_range`（是整数但大得不可能）都是 40001，
   *      只断言码的话，把上界整段删掉仍然全绿——被"非整数"那条守卫兜住了（覆盖假象）。
   * @why "多打一个 0"（2000 → 20000）**故意不测**：它仍在合法区间内，本护栏挡不住，
   *      这是 AJ-297 明写的已知缺口。写一条"它应该被拦"的用例等于假装解决了。
   */
  it('🔴 量纲上界：多打两个 0 → 40001，且 reason 与"填错格式"分开（AJ-297）', () => {
    expect(reasonOf(() => parseShippingRates([{ ...OK[0], max_weight_g: 200_001 }]))).toBe(
      'max_weight_g_out_of_range',
    );
    expect(reasonOf(() => parseShippingRates([{ ...OK[0], price_jpy: 100_001 }]))).toBe(
      'price_jpy_out_of_range',
    );
    // 上界本身放行（不能把极值本身拦掉）
    expect(
      parseShippingRates([{ ...OK[0], max_weight_g: 30_000, price_jpy: 100_000 }])[0]?.maxWeightG,
    ).toBe(30_000);
    // ⚠️ 已知缺口：10 倍（20000 g / 20000 円）仍在区间内 ⇒ 放行。如实钉住，不假装拦了。
    expect(parseShippingRates([{ ...OK[0], max_weight_g: 20_000 }])[0]?.maxWeightG).toBe(20_000);
    expect(parseShippingRates([{ ...OK[1], price_jpy: 20_000 }])[0]?.priceJpy).toBe(20_000);
  });

  it('同一承运商 + 上限重复 → 40001（DB UNIQUE 会拒，这里先给出可读原因）', () => {
    expect(codeOf(() => parseShippingRates([...OK, { ...OK[1] }]))).toBe(40001);
  });

  it('🔴 两家承运商同时启用 → 40001（活跃承运商 ≠1 家 = 全站 50004 运费不可计算）', () => {
    expect(
      codeOf(() =>
        parseShippingRates([...OK, { carrier: 'yamato', max_weight_g: 2000, price_jpy: 5000 }]),
      ),
    ).toBe(40001);
  });

  it('两家承运商但只有一家启用 → 通过（不拦"录着备用档位"这件事）', () => {
    const out = parseShippingRates([
      ...OK,
      { carrier: 'yamato', max_weight_g: 2000, price_jpy: 5000, active: false },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]?.active).toBe(false);
  });

  it('全部停用 → 40001（没有可取的档）', () => {
    const rows = OK.map((r) => ({ ...r, active: false }));
    expect(codeOf(() => parseShippingRates(rows))).toBe(40001);
    expect(reasonOf(() => parseShippingRates(rows))).toBe('no_active_tier');
  });

  it('合法整表：active 缺省为 true，carrier 两侧空白被 trim', () => {
    const out = parseShippingRates([
      { carrier: '  placeholder ', max_weight_g: 500, price_jpy: 2100 },
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4950, active: false },
    ]);
    expect(out).toEqual([
      { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: false },
    ]);
  });

  /**
   * 🔴 AJ-353："我要停用"不能被静默执行成"启用"。
   * @why 后果比 Banner 那条更重：运费档一旦启用就**参与取档**
   *      （`catalog.findShippingPriceJpy` 的 `where active = true`）——
   *      该停用的档位照常命中 ⇒ 同一个包裹取到另一个价，**运费算错且没有任何一方报错**。
   *      旧写法 `r['active'] !== false` 对 `"false"` 求值为 true，正是这个形态。
   * @why 顺带断言 reason 而不是只看码：整表校验里 40001 有七八个来源，
   *      只断言码的话"注入去掉 active 守卫"会被别的守卫兜住（覆盖假象）。
   */
  it('🔴 active 传字符串 "false" → 40001 active_invalid（不是被当成启用）', () => {
    const rows = [{ ...OK[0], active: 'false' }];
    expect(codeOf(() => parseShippingRates(rows))).toBe(40001);
    expect(reasonOf(() => parseShippingRates(rows))).toBe('active_invalid');
    // 0 与 1 也不是布尔：JS 里 `0 !== false` 为真 ⇒ 旧写法同样把它们当启用
    expect(codeOf(() => parseShippingRates([{ ...OK[0], active: 0 }]))).toBe(40001);
    // 全表都传字符串时不能退化成"全停用"（那会给出 no_active_tier，方向反掉）
    const all = OK.map((r) => ({ ...r, active: 'false' }));
    expect(reasonOf(() => parseShippingRates(all))).toBe('active_invalid');
  });

  it('active 传 null → 当"没传"，取缺省 true（与 product-input 的 isBlank 同口径，AJ-352）', () => {
    const out = parseShippingRates([{ ...OK[0], active: null }]);
    expect(out[0]?.active).toBe(true);
  });
});
