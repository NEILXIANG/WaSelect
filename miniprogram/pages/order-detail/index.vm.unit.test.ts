/**
 * 职责：订单详情页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是四个**都不报错**的事：
 *      ① 时间线时刻错 9 小时（UTC 存 JST 显，没有任何异常）；
 *      ② 关税被显示成"另收一行"（它是信息字段，用户会以为被收了两次）；
 *      ③ 取消按钮出现在不可取消的状态（点了就是一个看不懂的 40902）；
 *      ④ 行项目缺图时留白（用户分不清"没图"和"图没加载出来"）。
 */
import { describe, expect, it } from 'vitest';
import { amountLines, detailView, itemRows, timelineRows } from './index.vm.js';

const ORDER = {
  order_id: 'o-1',
  order_no: 'WS-20260927-0001',
  total_jpy: 9150,
  display: { USD: 6220, CNY: 44800 },
  status: 'shipped',
  created_at: '2026-09-27T02:00:00.000Z',
  expires_at: '2026-09-27T02:30:00.000Z',
  terms_version: 'TOS-2026-09-20',
  contact_email: 'buyer@example.com',
  items: [
    {
      product_id: 'p-1',
      title: '保温杯',
      qty: 2,
      unit_price_jpy: 2400,
      image: { card: 'https://img.example/p1-card.png' },
    },
    { product_id: 'p-2', title: '厨刀', qty: 1, unit_price_jpy: 3200 },
  ],
  address: {
    recipient: 'John Doe',
    phone: '+14155550123',
    line1: '1 Market St',
    line2: '',
    city: 'San Francisco',
    state: 'CA',
    postal_code: '94105',
  },
  items_jpy: 8000,
  shipping_jpy: 1150,
  duty_jpy: 1200,
  carrier: '日本郵便',
  tracking_no: 'EJ123456789JP',
  timeline: [
    { status: 'created', at: '2026-09-27T02:00:00.000Z' },
    { status: 'paid', at: '2026-09-27T02:05:00.000Z' },
    { status: 'shipped', at: '2026-09-28T15:04:26.000Z' },
  ],
};

describe('detailView（整体）', () => {
  it('字段透传 + 状态 + 金额', () => {
    const v = detailView(ORDER);
    expect(v.orderNo).toBe('WS-20260927-0001');
    expect(v.statusText).toBe('已发货');
    expect(v.canPay).toBe(false);
    expect(v.canCancel).toBe(false);
    expect(v.totalJpy).toBe(9150);
    expect(v.totalSub).toBe('≈ $62.20 · ≈ ¥448.00');
    expect(v.termsVersion).toBe('TOS-2026-09-20');
    expect(v.contactEmail).toBe('buyer@example.com');
  });

  it('⚠️ 时间全部按 JST 显示（UTC 存、错 9 小时没有任何异常）', () => {
    const v = detailView(ORDER);
    expect(v.createdAtText).toBe('2026-09-27 11:00');
    expect(v.timeline.map((t) => t.atText)).toEqual([
      '2026-09-27 11:00',
      '2026-09-27 11:05',
      '2026-09-29 00:04',
    ]);
    expect(v.timeline.map((t) => t.statusText)).toEqual(['待付款', '已付款', '已发货']);
  });

  it('⚠️ 可付时才显示截止时刻，且可付 == 可取消（半开状态没有任何测试能抓，除非同源）', () => {
    const pending = detailView({ ...ORDER, status: 'created' });
    expect(pending.canPay).toBe(true);
    expect(pending.canCancel).toBe(true);
    expect(pending.expiresAtText).toBe('2026-09-27 11:30');
    expect(detailView(ORDER).expiresAtText).toBe('');
  });

  // ⚠️ 这条是缺陷注入③首次**未变红**逼出来的：原用例只测了 created / shipped 两态，
  //    漏了"其它态都不可取消"这档——只测两个变量一起改的用例会造出覆盖假象。
  it('⚠️ 十个状态逐态断言：只有 created / pending_payment 可付可取消', () => {
    const ALL = [
      'created',
      'pending_payment',
      'paid',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'expired',
      'refunding',
      'refunded',
    ];
    for (const status of ALL) {
      const v = detailView({ ...ORDER, status });
      const expected = status === 'created' || status === 'pending_payment';
      expect(v.canPay, `${status} 的 canPay`).toBe(expected);
      expect(v.canCancel, `${status} 的 canCancel`).toBe(expected);
    }
  });

  it('⚠️ 解析不了的时刻回落**原串**（数据不能丢，宁可难看）', () => {
    const v = detailView({ ...ORDER, created_at: 'soon' });
    expect(v.createdAtText).toBe('soon');
  });

  it('运单：有单号 → hasTracking；没有 → 不显示整段', () => {
    expect(detailView(ORDER).hasTracking).toBe(true);
    expect(detailView(ORDER).trackingNo).toBe('EJ123456789JP');
    expect(detailView({ ...ORDER, tracking_no: undefined }).hasTracking).toBe(false);
  });

  it('脏输入：null / 空对象 → 不崩，且**不**显示可付/可取消', () => {
    const v = detailView(null);
    expect(v.canPay).toBe(false);
    expect(v.canCancel).toBe(false);
    expect(v.totalJpy).toBeNull();
    expect(v.items).toEqual([]);
    expect(v.timeline).toEqual([]);
    expect(v.statusText).toBe('状态未知');
    expect(detailView({}).address).toBeNull();
  });
});

describe('itemRows（行项目）', () => {
  it('单价是快照整数（缺了是 null 不是 0——0 会被读成"送的"）', () => {
    const [a, b] = itemRows(ORDER.items);
    expect(a).toEqual({
      productId: 'p-1',
      title: '保温杯',
      qty: 2,
      unitPriceJpy: 2400,
      unitPriceText: '2,400 円',
      image: 'https://img.example/p1-card.png',
    });
    expect(b?.image).toBe('/assets/placeholder.png'); // 缺图回落占位（留白和没图分不清）
    expect(b?.unitPriceText).toBe('3,200 円');
    expect(itemRows([{ product_id: 'x' }])[0]?.unitPriceJpy).toBeNull();
  });

  it('脏输入：非数组 → 空；没 product_id 的行丢掉', () => {
    expect(itemRows(null)).toEqual([]);
    expect(itemRows([{ title: 'x' }, ...ORDER.items])).toHaveLength(2);
  });
});

describe('amountLines（金额行）', () => {
  it('商品合计 / 运费 / 关税三行，且关税**必须带"含在商品价内"**', () => {
    expect(amountLines(ORDER)).toEqual([
      { label: '商品合计', value: '8,000 円' },
      { label: '运费', value: '1,150 円' },
      { label: '预估关税（含在商品价内）', value: '1,200 円' },
    ]);
  });

  it('⚠️ duty_jpy 不是整数 → 关税行整条消失（信息字段缺失时显示"关税：—" = 暗示"不收关税"）', () => {
    expect(amountLines({ items_jpy: 8000, shipping_jpy: 1150, duty_jpy: null })).toHaveLength(2);
    expect(amountLines({ items_jpy: 8000, duty_jpy: 0 })).toEqual([
      { label: '商品合计', value: '8,000 円' },
      { label: '预估关税（含在商品价内）', value: '0 円' },
    ]);
  });
});

describe('timelineRows（时间线）', () => {
  it('状态走共享词表；脏行丢掉', () => {
    expect(timelineRows(null)).toEqual([]);
    expect(
      timelineRows([
        { at: '2026-09-27T02:00:00Z' },
        { status: 'paid', at: '2026-09-27T02:05:00Z' },
      ]),
    ).toEqual([{ statusText: '已付款', atText: '2026-09-27 11:05' }]);
  });
});
