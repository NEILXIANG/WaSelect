/**
 * 职责：`admin-web/src/ops/view.ts` 的单测（运费分档 + 展示汇率）。
 *
 * @why 这两张表的错误**不会报错**：运费档位填反了是"每单少收钱"（D-46），
 *      汇率填反了是"所有展示价偏了"。能拦的形状问题必须在保存前拦完。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FX_QUOTES,
  emptyFxForm,
  emptyRateRow,
  fxFormErrors,
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

  it('填了时间才带上', () => {
    expect(
      toFxBody({ quote: 'CNY', rawRate: '0.048', effectiveFrom: '2026-10-01T00:00:00Z' }),
    ).toEqual({
      quote: 'CNY',
      raw_rate: 0.048,
      effective_from: '2026-10-01T00:00:00Z',
    });
  });

  it('⚠️ 空表单（默认 quote）也要先填汇率才能过', () => {
    expect(fxFormErrors(emptyFxForm()).ok).toBe(false);
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
