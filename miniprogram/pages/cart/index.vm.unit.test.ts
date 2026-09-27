/**
 * 职责：购物车页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是"错了不报错"的事：
 *      ① 行里出现小计 → 小计是"算合计"的半成品，走缓存价就破了红线
 *        （cart-store @limitation 一：价格变了没人发现）；
 *      ② 快照价非整数（旧版本脏数据）→ 整行渲染失败，而它只是参考信息。
 *
 * @why **报价区不在这里**：`quoteView` 已下沉到 `utils/quote-view.js`
 *      （确认订单页渲染同一块），它的守卫在 `quote-view.unit.test.ts`。
 *
 * @see ./index.vm.js
 */
import { describe, expect, it } from 'vitest';
import { cartRows } from './index.vm.js';

const ITEMS = [
  {
    productId: 'p-shiro-cleansing-oil',
    qty: 2,
    title: '資生堂 クレンジングオイル 200ml',
    image: 'https://img.example.com/p1/card.jpg',
    priceJpy: 3600,
  },
];

describe('cartRows（行视图）', () => {
  it('字段透传 + 快照价格式化（仅参考，不产出小计）', () => {
    const [row] = cartRows(ITEMS);
    expect(row).toEqual({
      productId: 'p-shiro-cleansing-oil',
      title: '資生堂 クレンジングオイル 200ml',
      image: 'https://img.example.com/p1/card.jpg',
      qty: 2,
      priceText: '3,600 円',
    });
    // ⚠️ 没有 subtotal 字段：行内小计 = "算合计"的半成品，走缓存价就破了红线
    expect(Object.keys(row ?? {})).not.toContain('subtotalText');
  });

  it('⚠️ 快照价非整数（旧版本脏数据）→ 不显示，而不是让整行渲染失败', () => {
    expect(cartRows([{ ...ITEMS[0], priceJpy: 3600.5 }])[0]?.priceText).toBe('');
    expect(cartRows([{ ...ITEMS[0], priceJpy: undefined }])[0]?.priceText).toBe('');
  });

  it('脏输入：非数组 → 空数组；qty 非整数 → 归一成 1', () => {
    expect(cartRows(undefined as never)).toEqual([]);
    expect(cartRows([{ productId: 'p-1', qty: '2' }])[0]?.qty).toBe(1);
  });
});
