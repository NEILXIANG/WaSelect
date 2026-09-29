/**
 * 职责：`admin-web/src/ops/view.ts` 的单测（运费分档 + 展示汇率）。
 *
 * @why 这两张表的错误**不会报错**：运费档位填反了是"每单少收钱"（D-46），
 *      汇率填反了是"所有展示价偏了"。能拦的形状问题必须在保存前拦完。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toIsoJst } from '../format.js';
import {
  FX_QUOTES,
  emptyFxForm,
  emptyRateRow,
  fxFormErrors,
  fxPreview,
  fxRows,
  rateErrors,
  rateRows,
  toFxBody,
  toRateBody,
} from './view.js';

/** 像真的运费表（锚点：2kg = 4,950 円；重量上限是"含"的上限——D-46）。 */
const RATES = [
  { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2200, active: true },
  { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
  { carrier: 'placeholder', max_weight_g: 5000, price_jpy: 4950, active: true },
];

const formRow = (max: string, price: string, active = true): Record<string, unknown> => ({
  carrier: 'placeholder',
  maxWeightG: max,
  priceJpy: price,
  active,
});

describe('fxRows', () => {
  it('映射出五个展示列（生效时间是 JST）', () => {
    const [row] = fxRows([
      {
        quote: 'USD',
        rate: 0.0066,
        raw_rate: 0.0067,
        buffer: 0.01,
        effective_from: '2026-09-27T00:00:00Z',
      },
    ]);
    expect(row).toEqual({
      quote: 'USD',
      rateText: '0.0066',
      rawRateText: '0.0067',
      bufferText: '0.01',
      effectiveText: '2026-09-27 09:00',
    });
  });

  it('⚠️ 缺字段显示占位符而不是 "undefined"', () => {
    const [row] = fxRows([{ quote: 'CNY' }]);
    expect(row?.rateText).toBe('—');
    expect(row?.effectiveText).toBe('—');
  });

  it('非数组输入给空列表', () => {
    expect(fxRows(null)).toEqual([]);
  });
});

describe('fxFormErrors / toFxBody', () => {
  it('合法表单通过', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0.0067' }).ok).toBe(true);
  });

  it('⚠️ 币种不在枚举内 → 拒（契约只认 CNY / USD）', () => {
    expect(fxFormErrors({ quote: 'EUR', rawRate: '1' }).first).toContain('CNY');
  });

  it('⚠️ raw_rate 为 0 / 负数 / 非数字 → 拒（展示价会变成 0 或 NaN）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '0' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'USD', rawRate: '-1' }).ok).toBe(false);
    expect(fxFormErrors({ quote: 'USD', rawRate: 'abc' }).ok).toBe(false);
  });

  it('⚠️ effective_from 为空则不带该字段（传空串会被当成非法 date-time）', () => {
    expect(toFxBody({ quote: 'USD', rawRate: ' 0.0067 ' })).toEqual({
      quote: 'USD',
      raw_rate: 0.0067,
    });
  });

  it('⚠️ 填了时间按 JST 转成带 +09:00 的 ISO（datetime-local 没有时区，直发会被当 UTC）', () => {
    expect(toFxBody({ quote: 'CNY', rawRate: '0.048', effectiveFrom: '2026-10-01T09:00' })).toEqual(
      {
        quote: 'CNY',
        raw_rate: 0.048,
        effective_from: '2026-10-01T09:00:00+09:00',
      },
    );
  });

  it('⚠️ 时间格式不对 → 校验先拦住（不让它变成空串发出去）', () => {
    expect(
      fxFormErrors({ quote: 'USD', rawRate: '0.0067', effectiveFrom: '2026/10/01' }).first,
    ).toContain('生效时间');
    expect(toIsoJst('2026/10/01')).toBe('');
    expect(toIsoJst('')).toBe('');
  });

  it('⚠️ 空表单（默认 quote）也要先填汇率才能过', () => {
    expect(fxFormErrors(emptyFxForm()).ok).toBe(false);
  });
});

describe('fxFormErrors 的上界（A8：与服务端 MAX_RAW_RATE 同源）', () => {
  /**
   * @why 服务端 `domain/fx-input.ts` 的 `MAX_RAW_RATE = 1000` 是量纲护栏
   *      （"1 円换不到 1000 个外币单位"）。前端不补同一条的话，
   *      "多打好几个 0"要等提交之后才被服务端 40001 拒，
   *      而运营看到的是泛化的"参数缺失或格式错误"，不知道错在小数点。
   *      ⚠️ 两个 1000 是**两处各写一份**（前端不能 import 服务端常量，见 MAX_RAW_RATE 的 @limitation）；
   *      这两条用例钉住边界，改一边忘一边会红，但要改两边仍靠人记得。
   */
  it('超过 1000 → 拒（且文案点明是小数点问题）', () => {
    const r = fxFormErrors({ quote: 'USD', rawRate: '1001' });
    expect(r.ok).toBe(false);
    expect(r.first).toContain('1000');
  });

  it('恰好 1000 → 放行（边界：不能把最大值本身拦掉）', () => {
    expect(fxFormErrors({ quote: 'USD', rawRate: '1000' }).ok).toBe(true);
  });
});

describe('fxPreview（A8：保存前的量级核对）', () => {
  /**
   * @why 2026-09-29 全量审查 A8：展示汇率**直接乘进真实扣款额**
   *      （`pay-intent.ts` 的 `resolveCharge`：USD 分支 `toMinor(total_jpy, rate)`）。
   *      而保存按钮是"一点即提交"，前端只查 >0，服务端上界 1000 只挡"多打好几个 0"，
   *      挡不住"反着填"（150）或"错一位"（0.067 / 0.00067）。
   *      录成 0.00067 之后每笔美元订单少收 90%；录成 150 多收两万倍，引来拒付。
   * @why 判据用**与当前生效值的倍数**而不是"这个数合不合理"：汇率本身会波动，
   *      绝对值没有"合理范围"（0.0067 和 0.049 都是对的），只有"相对上一次跳了多少"是可判的。
   */
  it('与当前值相差不大 → 不标红（正常波动不该被拦成硬失败）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.0068', currentRate: 0.0067 });
    expect(p.risky).toBe(false);
    expect(p.ratio).toBeCloseTo(1.015, 3);
  });

  it('🔴 错一位（10 倍）→ 标红，并给出倍数与样例金额', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.067', currentRate: 0.0067 });
    expect(p.risky).toBe(true);
    expect(p.ratio).toBeCloseTo(10, 6);
    expect(p.reason).toContain('倍');
    expect(p.sampleText).toBe('¥10,000 ≈ USD 670.00');
  });

  it('🔴 小数点错位（1/10）→ 同样标红（少收 90% 的方向更危险）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.00067', currentRate: 0.0067 });
    expect(p.risky).toBe(true);
    expect(p.ratio).toBeCloseTo(0.1, 6);
  });

  it('第一次配置（没有当前值）→ 不标红但也要给样例金额让人核对', () => {
    const p = fxPreview({ quote: 'USD', rawRate: '0.0067', currentRate: null });
    expect(p.ratio).toBeNull();
    expect(p.risky).toBe(false);
    expect(p.sampleText).toBe('¥10,000 ≈ USD 67.00');
  });

  it('填了非法值 → 给不出预览（由 fxFormErrors 负责报错，这里不重复造文案）', () => {
    const p = fxPreview({ quote: 'USD', rawRate: 'abc', currentRate: 0.0067 });
    expect(p.risky).toBe(false);
    expect(p.sampleText).toBe('');
  });
});

describe('rateRows', () => {
  it('⚠️ 按重量上限升序展示（乱序输入也要排好，否则看不出"比上一档还小"）', () => {
    const rows = rateRows([RATES[2], RATES[0], RATES[1]]);
    expect(rows.map((r) => r.maxWeightText)).toEqual(['500 g', '2000 g', '5000 g']);
  });

  it('价格走千分位，启用态原样带出', () => {
    const rows = rateRows(RATES);
    expect(rows[2]?.priceText).toBe('4,950 円');
    expect(rows[2]?.active).toBe(true);
  });

  it('⚠️ 同一承运商同一上限出现两次 → **两条都标** duplicate（只标后一条的话，运营看不出它跟谁撞了）', () => {
    const rows = rateRows([...RATES, { ...RATES[1] }]);
    expect(rows.filter((r) => r.duplicate)).toHaveLength(2);
    expect(rows.filter((r) => r.duplicate).map((r) => r.maxWeightText)).toEqual([
      '2000 g',
      '2000 g',
    ]);
  });
});

describe('rateErrors（整表校验）', () => {
  it('一张合法表全过', () => {
    expect(rateErrors([formRow('500', '2200'), formRow('2000', '4050')]).ok).toBe(true);
  });

  it('⚠️ 空表 → 拒（空表 = 所有订单无法报价）', () => {
    const r = rateErrors([]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('至少');
  });

  it('⚠️ 重复档位 → 拒（报的是"与前面某一档重复"，不是 DB 错误）', () => {
    const r = rateErrors([formRow('2000', '4050'), formRow('2000', '4950')]);
    expect(r.errors.some((e) => e.includes('重复'))).toBe(true);
  });

  it('⚠️ 上限非整数 / 小于 1 → 拒', () => {
    expect(rateErrors([formRow('0', '100')]).errors[0]).toContain('重量上限');
    expect(rateErrors([formRow('2.5', '100')]).errors[0]).toContain('重量上限');
  });

  it('⚠️ 运费负数 → 拒', () => {
    expect(rateErrors([formRow('500', '-1')]).errors[0]).toContain('运费');
  });

  it('⚠️ 全部停用 → 拒（没有启用档 = 没有运费可算）', () => {
    const r = rateErrors([formRow('500', '2200', false)]);
    expect(r.first).toContain('启用');
  });

  it('⚠️ 承运商为空 → 拒', () => {
    const r = rateErrors([{ carrier: '', maxWeightG: '500', priceJpy: '2200', active: true }]);
    expect(r.first).toContain('承运商');
  });

  it('多个问题一起返回（整表替换一次提交，逐条报要提交很多次）', () => {
    const r = rateErrors([formRow('x', 'y'), formRow('0', '-1')]);
    expect(r.errors.length).toBeGreaterThan(2);
  });

  it('🔴 运费留空 → 必须拒（A7：`Number(\'\')` = 0 曾让空值通过"≥0 的整数"）', () => {
    /**
     * @why 2026-09-29 全量审查 A7：旧实现用 `Number(priceJpy)`，而 `Number('')` 等于 **0**，
     *      "≥0 的整数"这道校验**放行空值**，提交时又把空值转成 `price_jpy: 0`。
     *      服务端把 0 円视为合法的"手动包邮"，于是运营"新增一档"只填了重量上限、
     *      没填运费（或清空后忘了重填），确认之后**这个重量段的所有订单运费都是 0**，
     *      不报任何错——正是本文件头引用的 D-46 那类"每单少收钱且静默"。
     *      重量上限因为要求 ≥1，空值会被拦下；**运费没有同等拦截**，不对称正是漏洞所在。
     */
    const r = rateErrors([formRow('2000', '')]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('运费必填');
  });

  it('🔴 运费只有空格 → 同样拒（trim 之后才算空）', () => {
    const r = rateErrors([formRow('2000', '   ')]);
    expect(r.ok).toBe(false);
    expect(r.first).toContain('运费必填');
  });

  it('🔴 重量上限留空 → 拒，且报的是"必填"而不是"必须是整数"（没填 ≠ 填错）', () => {
    const r = rateErrors([formRow('', '2200')]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('重量上限必填'))).toBe(true);
  });

  it('⚠️ 运费填 0 → 放行（包邮是合法意图，必须显式填）', () => {
    // @why 这条是上一条的对照组：拦的是"没填"，不是"填了 0"。
    //      把 0 也拦掉会让"包邮档"无法表达，于是有人会去改校验本身。
    expect(rateErrors([formRow('2000', '0')]).ok).toBe(true);
  });

  it('🔴 `1e3` / `0x10` → 拒（`Number()` 会把它们读成 1000 / 16）', () => {
    // @why 表单输入是字符串，`Number('1e3')` = 1000、`Number('0x10')` = 16，
    //      两者在旧实现里都"看着通过了校验"，实际写进库的是运营没打算写的数。
    expect(rateErrors([formRow('2000', '1e3')]).ok).toBe(false);
    expect(rateErrors([formRow('2000', '0x10')]).ok).toBe(false);
  });
});

describe('toRateBody', () => {
  it('⚠️ 换成服务端键名（maxWeightG → max_weight_g）', () => {
    expect(toRateBody([formRow('2000', '4050')])).toEqual([
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
    ]);
  });

  it('也能吃服务端形状的行（页面取回来直接改时传的是同一份）', () => {
    expect(toRateBody([RATES[1]])).toEqual([
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true },
    ]);
  });

  it('非数组 → 空数组（不是抛，也不是 [undefined]）', () => {
    expect(toRateBody(null)).toEqual([]);
  });

  it('新增档位默认值：上限留空（逼运营填，而不是继承上一档）', () => {
    expect(emptyRateRow('placeholder')).toEqual({
      carrier: 'placeholder',
      maxWeightG: '',
      priceJpy: '',
      active: true,
    });
  });

  it('🔴 运费留空 → **抛错**而不是发 `price_jpy: 0`（A7 纵深防御）', () => {
    /**
     * @why 校验（rateErrors）是主防线，但它只在 `RatesPanel.save` 里被调一次。
     *      组装（toRateBody）若自己回落成 0，就等于"主防线一旦被绕过，后果仍是静默少收钱"。
     *      走到这里还解析不出 = 校验与组装的口径已经漂移，那是一个**必须响亮失败**的
     *      内部不一致；抛错至少让这次提交停在原地，而不是把 0 円写进全站运费表。
     */
    expect(() => toRateBody([formRow('2000', '')])).toThrow(/无法解析|运费/);
    expect(() => toRateBody([formRow('2000', '1e3')])).toThrow(/无法解析|运费/);
  });
});

/**
 * ⚠️ 与契约的双向比对：quote 枚举必须**恰好等于** `POST /admin/fx` 的 enum。
 * @why 少了会"配不了某个币种的展示价"，多了会提交一个服务端必拒的值。
 */
describe('FX_QUOTES 与契约的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('quote: {type: string, enum:')) ?? '';

  it('抽到了 quote 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('quote');
    expect(line).toContain('enum');
  });

  it('两边集合相等', () => {
    const contract = (line.slice(line.indexOf('enum:')).match(/[A-Z]{3}/g) ?? []).sort();
    expect([...FX_QUOTES].sort()).toEqual(contract);
  });
});
