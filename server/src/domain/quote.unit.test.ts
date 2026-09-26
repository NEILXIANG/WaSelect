/**
 * 职责：报价域纯函数的 L0 单测（I1-U4）。
 *
 * @why 金额正确性不靠"看起来像"：duty 的断言值用 `applyRate` 独立复算、
 *      display 的断言值用 `toMinor` 独立复算——测试与实现共用同一取整口，
 *      但公式（什么乘什么、除谁）在这里各写一遍，公式写错会红。
 *
 * @see domain/quote.ts（被测）；docs/I1阶段开发实施方案.md §3.4
 */
import { describe, expect, it } from 'vitest';
import { applyRate, toMinor, toRateInt, toRatioInt } from '@waselect/shared';
import { AppError } from '../errors.js';
import {
  computeQuote,
  dutyRatioIntOf,
  summarizeQuoteItems,
  type QuoteComputationInput,
  type QuoteProduct,
} from './quote.js';

function product(overrides: Partial<QuoteProduct> = {}): QuoteProduct {
  return {
    productId: 'p-1',
    priceJpy: 3000,
    weightG: 400,
    stock: 10,
    active: true,
    originCountry: 'JP',
    ...overrides,
  };
}

/** 抓 AppError 的 code（比 toThrow 的消息匹配硬：消息改文案不炸，码错才炸）。 */
function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  throw new Error('预期抛 AppError，实际没抛');
}

describe('summarizeQuoteItems', () => {
  it('空 items → 40001', () => {
    expect(codeOf(() => summarizeQuoteItems([], []))).toBe(40001);
  });

  it('qty 非法（0 / 负 / 小数）→ 40001', () => {
    for (const qty of [0, -1, 1.5]) {
      expect(codeOf(() => summarizeQuoteItems([{ productId: 'p-1', qty }], [product()]))).toBe(
        40001,
      );
    }
  });

  it('product_id 重复 → 40001（合并语义不明，响亮拒绝）', () => {
    const items = [
      { productId: 'p-1', qty: 1 },
      { productId: 'p-1', qty: 2 },
    ];
    expect(codeOf(() => summarizeQuoteItems(items, [product()]))).toBe(40001);
  });

  it('商品不存在 → 40401；已下架同码（不泄露"存在但被下架"）', () => {
    expect(codeOf(() => summarizeQuoteItems([{ productId: 'ghost', qty: 1 }], []))).toBe(40401);
    expect(
      codeOf(() =>
        summarizeQuoteItems([{ productId: 'p-1', qty: 1 }], [product({ active: false })]),
      ),
    ).toBe(40401);
  });

  it('库存不足 → 40901（恰好等于库存放行）', () => {
    expect(
      codeOf(() => summarizeQuoteItems([{ productId: 'p-1', qty: 11 }], [product({ stock: 10 })])),
    ).toBe(40901);
    const s = summarizeQuoteItems([{ productId: 'p-1', qty: 10 }], [product({ stock: 10 })]);
    expect(s.itemsJpy).toBe(30_000);
  });

  it('多行汇总：小计 / 总重 / 原产地去重', () => {
    const s = summarizeQuoteItems(
      [
        { productId: 'p-1', qty: 2 },
        { productId: 'p-2', qty: 1 },
      ],
      [product(), product({ productId: 'p-2', priceJpy: 1500, weightG: 1200 })],
    );
    expect(s.itemsJpy).toBe(3000 * 2 + 1500);
    expect(s.goodsWeightG).toBe(400 * 2 + 1200);
    expect(s.origins).toEqual(['JP']);
  });
});

function baseInput(overrides: Partial<QuoteComputationInput> = {}): QuoteComputationInput {
  return {
    itemsJpy: 10_000,
    goodsWeightG: 1600,
    packagingWeightG: 250,
    shippingJpy: 4950,
    dutyRatioInt: toRatioInt('0.15000'),
    fxRateIntByCurrency: { USD: toRateInt('0.0067'), CNY: toRateInt('0.049') },
    displayCurrencies: ['USD', 'CNY'],
    freeShippingThresholdJpy: null,
    maxOrderJpy: 180_000,
    ...overrides,
  };
}

describe('computeQuote', () => {
  it('基准：total=items+shipping（不含 duty）、weight 含包材、duty/display 独立复算', () => {
    const q = computeQuote(baseInput());
    expect(q.itemsJpy).toBe(10_000);
    expect(q.shippingJpy).toBe(4950);
    expect(q.totalJpy).toBe(14_950);
    expect(q.weightG).toBe(1850); // 1600 + 250 包材（D-42）
    expect(q.dutyEstimated).toBe(true);
    expect(q.dutyJpy).toBe(applyRate(10_000, toRatioInt('0.15000')));
    expect(q.display['USD']).toBe(toMinor(14_950, toRateInt('0.0067')));
    expect(q.display['CNY']).toBe(toMinor(14_950, toRateInt('0.049')));
    expect(q.freeShippingRemainingJpy).toBeNull();
    expect(q.splitHint).toBe(false);
  });

  it('duty 无税率行 → dutyJpy=null 且 estimated=false（不阻单，信息缺失而已）', () => {
    const q = computeQuote(baseInput({ dutyRatioInt: null }));
    expect(q.dutyJpy).toBeNull();
    expect(q.dutyEstimated).toBe(false);
    expect(q.totalJpy).toBe(14_950); // duty 本来就不计入 total
  });

  it('包邮：达阈值运费为 0；未达阈值给出差额；未配置不包邮', () => {
    const free = computeQuote(baseInput({ freeShippingThresholdJpy: 10_000 }));
    expect(free.shippingJpy).toBe(0);
    expect(free.freeShippingRemainingJpy).toBeNull();

    const almost = computeQuote(baseInput({ freeShippingThresholdJpy: 12_000 }));
    expect(almost.shippingJpy).toBe(4950);
    expect(almost.freeShippingRemainingJpy).toBe(2000);
  });

  it('任一展示币汇率缺失 → 50003（阻止下单，不静默少显示一种币）', () => {
    expect(codeOf(() => computeQuote(baseInput({ fxRateIntByCurrency: { USD: 670_000 } })))).toBe(
      50003,
    );
  });

  it('金额超 MAX_ORDER_JPY → splitHint=true（报价只提示，建单才硬拦 40906）', () => {
    const q = computeQuote(baseInput({ itemsJpy: 179_000, shippingJpy: 4950 }));
    expect(q.splitHint).toBe(true);
  });

  it('展示币为空数组 → display 为空（不要求汇率，也不该 50003）', () => {
    const q = computeQuote(baseInput({ displayCurrencies: [] }));
    expect(q.display).toEqual({});
  });
});

describe('dutyRatioIntOf', () => {
  it('null 直通（无税率行的领域语义）；NUMERIC 字符串转 ×1e8 整数', () => {
    expect(dutyRatioIntOf(null)).toBeNull();
    expect(dutyRatioIntOf('0.15000')).toBe(15_000_000);
  });
});
