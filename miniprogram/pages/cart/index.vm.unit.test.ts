/**
 * 职责：购物车页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的都是"错了不报错"的事：
 *      ① 快照价被拿去算小计/合计 → 价格变了没人发现（cart-store @limitation 一）；
 *      ② 关税在估值都没有时显示"—" → 用户读成"不收关税"（契约：信息字段）；
 *      ③ 免邮提示 / 拆单提示在不该出现时出现 → 报价区说假话。
 *
 * @see ../index.vm.js
 */
import { describe, expect, it } from 'vitest';
import { cartRows, quoteView } from './index.vm.js';

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

describe('quoteView（报价区）', () => {
  const QUOTE = {
    items_jpy: 7200,
    shipping_jpy: 1950,
    duty_jpy: 936,
    duty_estimate: true,
    total_jpy: 9150,
    weight_g: 1850,
    display: { USD: 6220, CNY: 44800 },
    free_shipping_remaining_jpy: 0,
    split_hint: false,
  };

  it('完整报价：商品合计 + 运费 + 预估关税行 + 合计（三币）', () => {
    const v = quoteView(QUOTE);
    expect(v.lines).toEqual([
      { label: '商品合计', value: '7,200 円' },
      { label: '运费', value: '1,950 円' },
      { label: '预估关税（含在商品价内）', value: '936 円' },
    ]);
    expect(v.totalText).toBe('9,150 円');
    expect(v.hasTotal).toBe(true);
    expect(v.totalJpy).toBe(9150);
    expect(v.totalSub).toBe('≈ $62.20 · ≈ ¥448.00');
    expect(v.hints).toEqual([]);
  });

  it('⚠️ duty_estimate=false（或 duty_jpy=null）→ **不显示关税行**', () => {
    // @why 契约明说 duty 是信息字段；估值都没有时显示"关税：—"，
    //      用户会读成"没算关税 = 不收关税"——那是两种完全不同的事。
    expect(quoteView({ ...QUOTE, duty_estimate: false, duty_jpy: null }).lines).toHaveLength(2);
    expect(quoteView({ ...QUOTE, duty_estimate: true, duty_jpy: null }).lines).toHaveLength(2);
    // ⚠️ 上面两条**同时**把 duty_jpy 也改成了 null，只覆盖了"数字都没有"这一种；
    //    "duty_jpy 有数字但不是估值"才是真正会骗人的那一档（有数所以敢显示）——
    //    缺陷注入（去掉 duty_estimate===true 判断）曾因这两条而**未变红**，故补此行。
    expect(quoteView({ ...QUOTE, duty_estimate: false, duty_jpy: 936 }).lines).toHaveLength(2);
    expect(quoteView({ ...QUOTE, duty_estimate: false, duty_jpy: 936 }).lines).not.toContainEqual({
      label: '预估关税（含在商品价内）',
      value: '936 円',
    });
  });

  it('免邮差额 > 0 → 提示"再买 X 免运费"；split_hint → 拆单提示', () => {
    const v = quoteView({ ...QUOTE, free_shipping_remaining_jpy: 1200, split_hint: true });
    expect(v.hints).toEqual(['再买 1,200 円 免运费', '单笔金额接近出口申报上限，建议拆成两单']);
  });

  it('⚠️ 缺字段降级：只缺运费 → 其余行还在（不让整个报价区消失）', () => {
    const v = quoteView({ items_jpy: 7200 });
    expect(v.lines).toEqual([{ label: '商品合计', value: '7,200 円' }]);
    expect(v.hasTotal).toBe(false);
    expect(v.totalJpy).toBeNull();
    expect(v.totalText).toBe('');
    expect(v.totalSub).toBe('');
  });

  it('脏输入：null / 非对象 → 全空壳，不抛', () => {
    expect(quoteView(null)).toMatchObject({ lines: [], hasTotal: false, totalText: '' });
    expect(quoteView('x')).toMatchObject({ lines: [], hasTotal: false, totalText: '' });
  });
});
