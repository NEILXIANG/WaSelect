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
import { STOCK_REFUND_NOTE } from '../../utils/order-status.js';
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
    expect(v.createdAtText).toBe('2026-09-27 11:00（日本时间）');
    expect(v.timeline.map((t) => t.atText)).toEqual([
      '2026-09-27 11:00（日本时间）',
      '2026-09-27 11:05（日本时间）',
      '2026-09-29 00:04（日本时间）',
    ]);
    expect(v.timeline.map((t) => t.statusText)).toEqual(['待付款', '已付款', '已发货']);
  });

  /**
   * MP3-02：不带时区标注时，美国买家会把"请在 22:30 前完成支付"读成自己的本地时间
   * （PDT 与 JST 差 16 小时）→ 以为还有一整天，回来时订单已超时关闭，且不会报任何错。
   */
  it('🔴 每个买家可见的时刻都必须带时区标注（MP3-02）', () => {
    const pending = detailView({ ...ORDER, status: 'pending_payment' });
    expect(pending.createdAtText).toMatch(/日本时间|JST/);
    expect(pending.expiresAtText).toMatch(/日本时间|JST/);
    for (const t of pending.timeline) expect(t.atText, t.statusText).toMatch(/日本时间|JST/);
    // 换算不出来的时刻**不加**标注：不给"没换算过的时间"盖"日本时间"的章
    const dirty = detailView({ ...ORDER, created_at: 'soon', status: 'pending_payment' });
    expect(dirty.createdAtText).toBe('soon');
  });

  it('⚠️ 可付时才显示截止时刻，且可付 == 可取消（半开状态没有任何测试能抓，除非同源）', () => {
    const pending = detailView({ ...ORDER, status: 'created' });
    expect(pending.canPay).toBe(true);
    expect(pending.canCancel).toBe(true);
    expect(pending.expiresAtText).toBe('2026-09-27 11:30（日本时间）');
    expect(detailView(ORDER).expiresAtText).toBe('');
  });

  it('时间线行自带 wx:key 用的序号（不能用 index 当 key，开发者工具会告警）', () => {
    const keys = detailView(ORDER).timeline.map((t) => t.key);
    expect(keys).toEqual(['tl-0', 'tl-1', 'tl-2']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * MP3-04（P1）：买家在托管页付完款、切回微信的那几秒里，服务端订单**仍是待付款**，
   * 详情页若照常规口径给出「取消订单」，用户会以为刚才没付上而点它 → 钱随后到达、
   * 订单已关、只能人工退款。
   */
  it('🔴 刚付过款（justPaid）且状态仍可付 → 不给「取消」也不给「继续支付」，改显示确认中', () => {
    const v = detailView({ ...ORDER, status: 'pending_payment' }, { justPaid: true });
    expect(v.canCancel).toBe(false);
    expect(v.canPay).toBe(false);
    expect(v.confirming).toBe(true);
    expect(v.confirmHint).toBe('支付结果确认中，请稍后刷新');
    expect(v.needsRecheck).toBe(true);
  });

  it('🔴 不带 justPaid 时行为完全不变（这条防线不能误伤日常取消）', () => {
    const v = detailView({ ...ORDER, status: 'pending_payment' });
    expect(v.canCancel).toBe(true);
    expect(v.canPay).toBe(true);
    expect(v.confirming).toBe(false);
    expect(v.confirmHint).toBe('');
    expect(v.needsRecheck).toBe(false);
    // 第二参数缺省 / 传脏值都等于不传
    expect(detailView({ ...ORDER, status: 'pending_payment' }, null).canCancel).toBe(true);
    expect(detailView({ ...ORDER, status: 'pending_payment' }, { justPaid: 'yes' }).canCancel).toBe(
      true,
    );
  });

  it('🔴 justPaid 只在**仍可付**时生效：服务端已确认（paid）就不再遮住按钮', () => {
    const v = detailView({ ...ORDER, status: 'paid' }, { justPaid: true });
    expect(v.confirming).toBe(false);
    expect(v.canCancel).toBe(false); // paid 本来就不可取消（与 justPaid 无关）
    expect(v.needsRecheck).toBe(false);
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

  it('🔴 查件链接（剩余清单 3-5）：服务端给了 https 链接才显示；缺失 / 非 https → 空串（不显示"复制查件链接"）', () => {
    const url =
      'https://trackings.post.japanpost.jp/services/srv/search?requestNo1=EJ123456789JP&locale=en';
    expect(detailView({ ...ORDER, tracking_url: url }).trackingUrl).toBe(url);
    expect(detailView(ORDER).trackingUrl).toBe('');
    expect(detailView({ ...ORDER, tracking_url: 'javascript:alert(1)' }).trackingUrl).toBe('');
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
    ).toEqual([{ key: 'tl-0', statusText: '已付款', atText: '2026-09-27 11:05（日本时间）' }]);
  });
});

/** 合计标签按状态切换（W-04）：已付款的单写"应付合计"，用户会读成"还要再付这么多"。 */
describe('detailView：合计标签（W-04）', () => {
  it.each([
    ['created', '应付合计'],
    ['pending_payment', '应付合计'],
    ['paid', '订单合计'],
    ['shipped', '订单合计'],
    ['refunded', '订单合计'],
  ])('%s → %s', (status, label) => {
    expect(detailView({ order_id: 'o-1', status, total_jpy: 1000 }).totalLabel).toBe(label);
  });
});

/** 关税无法估算时服务端回 null（W-05 / 契约 0.6.30）：不能显示成"预估关税 0 円"。 */
describe('detailView：无法估算的关税不显示（W-05）', () => {
  it('duty_jpy=null → 没有关税行；整数 → 有', () => {
    const base = {
      order_id: 'o-1',
      status: 'paid',
      items_jpy: 1000,
      shipping_jpy: 500,
      total_jpy: 1500,
    };
    const labels = (o: Record<string, unknown>) =>
      detailView(o).amountLines.map((l: { label: string }) => l.label);
    expect(labels({ ...base, duty_jpy: null }).some((l: string) => l.includes('关税'))).toBe(false);
    expect(labels({ ...base, duty_jpy: 150 }).some((l: string) => l.includes('关税'))).toBe(true);
  });
});

/** 剩余清单 4-10（A40）：缺货整单退款说明。 */
describe('stockRefundNote（4-10）', () => {
  it('🔴 已付款未发货（paid）→ 显示说明；其它状态 → 空串（发货后 / 未付款时说这句只会让人困惑）', () => {
    expect(detailView({ ...ORDER, status: 'paid' }).stockRefundNote).toBe(STOCK_REFUND_NOTE);
    for (const st of ['pending_payment', 'shipped', 'delivered', 'refunded', 'cancelled']) {
      expect(detailView({ ...ORDER, status: st }).stockRefundNote, st).toBe('');
    }
    expect(STOCK_REFUND_NOTE).toContain('全额退款');
  });
});
