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
import { STOCK_REFUND_NOTE, buyerStatus } from '../../utils/order-status.js';
import {
  actionFailure,
  amountLines,
  buyAgainItems,
  detailView,
  dutyNote,
  itemRows,
  timelineRows,
} from './index.vm.js';

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
    // M-06（AJ-405）：当前状态改用买家视角文案（原断言 '已发货'，口径已按 AJ-402 Q4 改）
    expect(v.statusText).toBe('已发货 · 国际运输中');
    expect(v.canPay).toBe(false);
    expect(v.canCancel).toBe(false);
    expect(v.totalJpy).toBe(9150);
    expect(v.totalSub).toBe('≈ $62.20 · ≈ 人民币 ¥448.00');
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

  it('🔴 重查两次仍未确认（recheckGaveUp）→ 按钮恢复，但提示"可能还没到账、请勿重复付款"', () => {
    const v = detailView({ ...ORDER, status: 'pending_payment' }, { recheckGaveUp: true });
    expect(v).toMatchObject({ confirming: false, canPay: true, canCancel: true });
    expect(v.confirmHint).toContain('请勿重复付款');
    // 服务端已确认（paid）→ 不再提示
    expect(detailView({ ...ORDER, status: 'paid' }, { recheckGaveUp: true }).confirmHint).toBe('');
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
  it('🔴 MP-11（第二轮审计 2026-10-11）：只有商品合计 / 运费两行——关税不再与它们并列（三行相加 ≠ 合计）', () => {
    expect(amountLines(ORDER)).toEqual([
      { label: '商品合计', value: '8,000 円' },
      { label: '运费', value: '1,150 円' },
    ]);
  });

  it('🔴 MP-11：关税改成合计下方一句说明，且**必须带"含在商品价内"**（信息字段，不是另收）', () => {
    expect(dutyNote(ORDER)).toBe('其中预估关税 1,200 円（已含在商品价内）');
    expect(detailView(ORDER).dutyNote).toBe('其中预估关税 1,200 円（已含在商品价内）');
  });

  it('⚠️ duty_jpy 不是整数 → 不说关税（信息字段缺失时显示"关税：—" = 暗示"不收关税"）；0 照实说', () => {
    expect(amountLines({ items_jpy: 8000, shipping_jpy: 1150, duty_jpy: null })).toHaveLength(2);
    expect(dutyNote({ items_jpy: 8000, duty_jpy: null })).toBe('');
    expect(dutyNote({ items_jpy: 8000, duty_jpy: '1200' })).toBe('');
    expect(dutyNote(null)).toBe('');
    expect(dutyNote({ items_jpy: 8000, duty_jpy: 0 })).toBe('其中预估关税 0 円（已含在商品价内）');
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
    // MP-11：关税从金额行挪到合计下方的说明（dutyNote）；金额行任何时候都不带关税
    const labels = (o: Record<string, unknown>) =>
      detailView(o).amountLines.map((l: { label: string }) => l.label);
    expect(labels({ ...base, duty_jpy: 150 }).some((l: string) => l.includes('关税'))).toBe(false);
    expect(detailView({ ...base, duty_jpy: null }).dutyNote).toBe('');
    expect(detailView({ ...base, duty_jpy: 150 }).dutyNote).toContain('关税');
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

describe('detailView：确认收货（P2-13，AJ-387）', () => {
  it('🔴 只有已发货的单给"确认收货"；其余状态不给', () => {
    expect(detailView({ status: 'shipped' }).canConfirmReceipt).toBe(true);
    for (const s of ['paid', 'delivered', 'completed', 'refunding', '']) {
      expect(detailView({ status: s }).canConfirmReceipt).toBe(false);
    }
  });
});

describe('detailView：部分退款与迟到付款（P2-11 / P2-12，AJ-386）', () => {
  it('🔴 部分退款按币种格式化、成功 / 处理中分开说；没有则空数组', () => {
    const v = detailView({
      status: 'delivered',
      partial_refunds: [
        {
          status: 'succeeded',
          currency: 'USD',
          amount_minor: 1250,
          created_at: '2026-10-06T01:00:00.000Z',
        },
        {
          status: 'pending',
          currency: 'JPY',
          amount_minor: 800,
          created_at: '2026-10-06T02:00:00.000Z',
        },
      ],
    });
    expect(
      v.partialRefunds.map((r: { amountText: string; statusText: string }) => [
        r.amountText,
        r.statusText,
      ]),
    ).toEqual([
      ['$12.50', '已退回'],
      ['800 円', '退款处理中'],
    ]);
    expect(detailView({ status: 'paid' }).partialRefunds).toEqual([]);
  });

  it('认不出的币种 / 脏数据：不编金额，行照常列（买家至少知道有一笔退款）', () => {
    const v = detailView({
      status: 'delivered',
      partial_refunds: [{ status: 'succeeded', currency: 'EUR', amount_minor: 100 }, null, 'x'],
    });
    expect(v.partialRefunds).toHaveLength(1);
    expect(v.partialRefunds[0]?.amountText).toBe('EUR（金额以银行账单为准）');
  });

  it('🔴 late_paid → 说"已收到付款，会原路退回"（关闭态放顶部下一步，其余放页底）；否则空串', () => {
    // OPS-4（第二轮审计 2026-10-11）：关闭态原先页底说"无需重新付款"、顶部却说"如需购买请重新下单"
    expect(detailView({ status: 'expired', late_paid: true }).nextText).toContain('原路退回');
    expect(detailView({ status: 'refunding', late_paid: true }).latePaidNote).toContain('原路退回');
    expect(detailView({ status: 'expired' }).latePaidNote).toBe('');
  });
});

/**
 * M-06（AJ-405）：状态区的"下一步会发生什么"。
 * @why 时间线是**历史**（"那时候发生了什么"），保留短词；状态区是**现在**，用代购视角文案 + 下一步。
 *      两者混用的后果：时间线里"已付款 · 日本采购中"挂在一张早已发货的单上，读起来像还在采购。
 */
describe('detailView：买家视角状态与下一步（M-06）', () => {
  it('🔴 已付款 + 留了邮箱 → 标题"日本采购中"，下一步说会发邮件告知运单号', () => {
    const v = detailView({ ...ORDER, status: 'paid' });
    expect(v.statusText).toBe('已付款 · 日本采购中');
    expect(v.nextText).toBe(buyerStatus('paid', { email: true }).next);
    expect(v.nextText).toContain('邮件');
  });

  it('🔴 已付款 + 没留邮箱 → 不承诺邮件', () => {
    const v = detailView({ ...ORDER, status: 'paid', contact_email: undefined });
    expect(v.nextText).toBe(buyerStatus('paid', { email: false }).next);
    expect(v.nextText).not.toContain('邮件');
  });

  it('时间线仍用短词（历史记录，不随当前状态变）', () => {
    expect(detailView({ ...ORDER, status: 'delivered' }).timeline.map((t) => t.statusText)).toEqual(
      ['待付款', '已付款', '已发货'],
    );
  });

  it('未知状态 → "状态未知" + 指向客服', () => {
    const v = detailView({ ...ORDER, status: 'brand_new' });
    expect(v.statusText).toBe('状态未知');
    expect(v.nextText).toBe('如有疑问，请联系客服并提供订单号');
  });

  it('🔴 刚付过款确认中（justPaid）→ 不显示"请继续支付"那句下一步（与确认提示矛盾）', () => {
    const v = detailView({ ...ORDER, status: 'pending_payment' }, { justPaid: true });
    expect(v.confirming).toBe(true);
    expect(v.nextText).toBe('');
    expect(detailView({ ...ORDER, status: 'pending_payment' }).nextText).toBe(
      buyerStatus('pending_payment').next,
    );
  });
});

describe('detailView：进度条（M-12，AJ-408；算法在 utils/order-progress，这里只测接线）', () => {
  it('🔴 已发货 → 前四步（含发货）已完成，送达为当前（国际运输中），无分支', () => {
    const p = detailView(ORDER).progress;
    expect(p.show).toBe(true);
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(p.branch).toBeNull();
  });

  it('🔴 退款单用响应里的时间线决定点亮到哪一步', () => {
    const p = detailView({
      ...ORDER,
      status: 'refunded',
      timeline: [
        { status: 'created', at: '2026-09-27T02:00:00.000Z' },
        { status: 'paid', at: '2026-09-27T02:10:00.000Z' },
        { status: 'refunding', at: '2026-09-28T02:10:00.000Z' },
        { status: 'refunded', at: '2026-09-29T02:10:00.000Z' },
      ],
    }).progress;
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped']);
    expect(p.branch?.title).toBe('已退款');
  });

  it('未知状态 / 脏输入 → 不显示进度条', () => {
    expect(detailView({ ...ORDER, status: 'brand_new' }).progress.show).toBe(false);
    expect(detailView(null).progress.show).toBe(false);
  });
});

describe('过了支付截止时间（审查 2026-10-09）', () => {
  const pending = {
    order_id: 'ord-1',
    order_no: '261009-K7Q2MN',
    status: 'pending_payment',
    total_jpy: 9150,
    created_at: '2026-10-09T01:00:00.000Z',
    expires_at: '2026-10-09T01:30:00.000Z',
  };
  it('🔴 截止已过（关单作业还没跑）→ 不给「继续支付 / 取消订单」，下一步说明支付时间已到', () => {
    const v = detailView(pending, { nowMs: Date.parse('2026-10-09T01:30:00.000Z') });
    expect(v.canPay).toBe(false);
    expect(v.canCancel).toBe(false);
    expect(v.nextText).toBe('支付时间已到，订单将自动关闭；如需购买请重新下单');
  });
  it('截止前 1 秒 → 仍可付可取消；不传 nowMs → 按原行为（老调用方不受影响）', () => {
    const v = detailView(pending, { nowMs: Date.parse('2026-10-09T01:29:59.000Z') });
    expect(v.canPay).toBe(true);
    expect(v.canCancel).toBe(true);
    expect(detailView(pending).canPay).toBe(true);
  });
});

describe('底部操作栏出不出现（A2，AJ-416）', () => {
  it('🔴 hasActions = 能付 / 能取消 / 能确认收货 任一成立；已付款未发货、刚付过确认中时没有栏', () => {
    expect(detailView({ ...ORDER, status: 'pending_payment' }).hasActions).toBe(true);
    expect(detailView({ ...ORDER, status: 'shipped' }).hasActions).toBe(true);
    expect(detailView({ ...ORDER, status: 'paid' }).hasActions).toBe(false);
    expect(detailView({ ...ORDER, status: 'pending_payment' }, { justPaid: true }).hasActions).toBe(
      false,
    );
  });
});

describe('再次购买（A7，AJ-416）', () => {
  it('🔴 已送达 / 已完成 / 已取消 / 超时关闭 / 已退款 → 给「再次购买」（并因此出底栏）；进行中的单不给', () => {
    for (const status of ['delivered', 'completed', 'cancelled', 'expired', 'refunded']) {
      const v = detailView({ ...ORDER, status });
      expect(v.canBuyAgain, status).toBe(true);
      expect(v.hasActions, status).toBe(true);
    }
    for (const status of ['created', 'pending_payment', 'paid', 'shipped', 'refunding']) {
      expect(detailView({ ...ORDER, status }).canBuyAgain, status).toBe(false);
    }
  });

  it('🔴 再次购买的条目：商品 id + 原数量 + 标题 / 图快照（不带价格：价格以重新报价为准）', () => {
    const items = buyAgainItems({
      items: [
        { product_id: 'p-1', title: '白色恋人 12 枚装', qty: 2, unit_price_jpy: 2160, image: null },
        { product_id: '', title: '坏行', qty: 1 },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: 'p-1', qty: 2, title: '白色恋人 12 枚装' });
    expect(Object.keys(items[0] ?? {})).not.toContain('priceJpy');
    expect(buyAgainItems(null)).toEqual([]);
  });
});

describe('detailView · 售后卡片（AJ-420）', () => {
  it('🔴 已签收无申请 → 给入口；有进行中的申请 → 显示进度、不给入口；待发货 → 不出卡片', () => {
    expect(detailView({ status: 'delivered' }).afterSale).toEqual({
      show: true,
      canApply: true,
      current: null,
    });
    const open = detailView({
      status: 'delivered',
      after_sale: {
        id: 'as-1',
        reason: 'wrong_item',
        description: '收到的是抹茶味，下单的是原味',
        status: 'open',
        created_at: '2026-10-08T03:00:00.000Z',
        updated_at: '2026-10-08T03:00:00.000Z',
      },
    }).afterSale;
    expect(open).toMatchObject({ show: true, canApply: false });
    expect(open.current).toMatchObject({ reasonText: '发错商品', statusText: '已提交，等待处理' });
    expect(detailView({ status: 'paid' }).afterSale.show).toBe(false);
  });
});

describe('detailView · 状态区提示跟着售后走（三端联动模拟 2026-10-10）', () => {
  const as = (status: string) => ({
    id: 'as-1',
    reason: 'damaged',
    description: '外箱压扁',
    status,
    created_at: '2026-10-08T03:00:00.000Z',
    updated_at: '2026-10-08T03:00:00.000Z',
  });

  it('🔴 有进行中的售后：不再说"可以申请售后"，改说处理中（下面就是售后卡片，上下两句不能打架）', () => {
    for (const s of ['open', 'processing']) {
      const v = detailView({ status: 'delivered', after_sale: as(s) });
      expect(v.nextText).toBe('售后申请处理中，处理结果会在本页回复。');
      expect(v.statusText).toBe('已送达');
    }
  });

  it('🔴 售后已结案：提示看下方结果，还有问题可再次申请', () => {
    for (const s of ['resolved', 'rejected']) {
      expect(detailView({ status: 'completed', after_sale: as(s) }).nextText).toBe(
        '售后已有处理结果（见下方）；还有问题可以再次申请。',
      );
    }
  });

  // 严格检查（2026-10-10）：退款中 / 已退款的单讲钱的进度更要紧，且这两态没有申请入口——说"还可以再次申请"是空话；与列表同口径
  it('🔴 退款中 / 已退款的单有售后记录也不接管：仍说退款进度', () => {
    for (const st of ['refunding', 'refunded']) {
      for (const as_ of ['open', 'resolved']) {
        expect(detailView({ status: st, after_sale: as(as_) }).nextText).toBe(
          detailView({ status: st }).nextText,
        );
      }
    }
  });

  it('没有售后 / 售后状态认不出：照旧用订单状态的提示', () => {
    expect(detailView({ status: 'delivered' }).nextText).toBe(
      '如果实际没有收到，或商品有问题，可以申请售后，处理结果会在本页回复。',
    );
    expect(detailView({ status: 'delivered', after_sale: as('weird') }).nextText).toBe(
      '如果实际没有收到，或商品有问题，可以申请售后，处理结果会在本页回复。',
    );
  });
});

describe('detailView · 改地址的出路（联动走查·熟手买家 2026-10-10）', () => {
  it('🔴 已付款未发货：收货地址下说明"发货前改地址找客服"（买家端没有自助改址，管理端有「改址」）', () => {
    expect(detailView({ status: 'paid' }).addressChangeHint).toBe(
      '发货前需要改地址，请联系客服并提供订单号；发货后无法更改。',
    );
  });

  it('其它状态不说：待付款可以取消重下，已发货之后已经改不了', () => {
    for (const s of [
      'created',
      'pending_payment',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ]) {
      expect(detailView({ status: s }).addressChangeHint).toBe('');
    }
  });
});

// 第 24 项（2026-10-10）：查件引导——原先只有"复制查件链接"，复制之后该干什么没说（小程序里打不开外部网页）
describe('detailView · 查件引导', () => {
  it('🔴 有官方查件链接 → 说清"复制后到手机浏览器粘贴打开"；没有链接 → 复制运单号到承运商官网查', () => {
    const shipped = { status: 'shipped', carrier: 'Japan Post EMS', tracking_no: 'EJ123456789JP' };
    expect(
      detailView({
        ...shipped,
        tracking_url: 'https://trackings.post.japanpost.jp/x?n=EJ123456789JP',
      }).trackingHint,
    ).toBe('点「复制查件链接」，在手机浏览器（Safari / Chrome）里粘贴打开——是日本邮政官网的查件页');
    expect(
      detailView({ ...shipped, carrier: 'Yamato', tracking_no: '1234-5678-9012' }).trackingHint,
    ).toBe('点运单号复制，到承运商官网粘贴查询');
  });
});

describe('第二轮审计 2026-10-11：订单详情（OPS-4 / F1 / MP-7）', () => {
  it('🔴 OPS-4 迟到付款的已关闭单：不给「再次购买」，顶部说"会原路退回"而不是"请重新下单"，页底不再重复', () => {
    for (const status of ['expired', 'cancelled']) {
      const v = detailView({ ...ORDER, status, late_paid: true });
      expect(v.canBuyAgain, status).toBe(false);
      expect(v.nextText, status).toContain('原路退回');
      expect(v.nextText, status).not.toContain('重新下单');
      expect(v.latePaidNote, status).toBe('');
    }
    // 钱已退回（refunded）：再次购买照常给，页底说明保留
    const refunded = detailView({ ...ORDER, status: 'refunded', late_paid: true });
    expect(refunded.canBuyAgain).toBe(true);
    expect(refunded.latePaidNote).toContain('原路退回');
    // 不带 late_paid 的超时单：行为不变（仍给再次购买）
    expect(detailView({ ...ORDER, status: 'expired' }).canBuyAgain).toBe(true);
  });

  it('🔴 F1 确认中（justPaid）：不显示付款截止，合计不叫"应付合计"（刚付过的人读到"应付"会以为还要付）', () => {
    const v = detailView({ ...ORDER, status: 'pending_payment' }, { justPaid: true });
    expect(v.confirming).toBe(true);
    expect(v.expiresAtText).toBe('');
    expect(v.totalLabel).toBe('订单合计');
    // 常规待付款不受影响
    const plain = detailView({ ...ORDER, status: 'pending_payment' });
    expect(plain.expiresAtText).not.toBe('');
    expect(plain.totalLabel).toBe('应付合计');
  });

  it('🔴 MP-7 取消 / 确认收货撞上 40902 / 40904 → 重取订单 + 一句人话；其它错误不接管', () => {
    const stale = actionFailure({ code: 40902 });
    expect(stale.reload).toBe(true);
    expect(stale.note).toContain('已为你刷新');
    expect(stale.note).not.toContain('不允许此操作');
    expect(actionFailure({ code: 40904 })).toMatchObject({ reload: true });
    for (const e of [
      { code: 50000 },
      { code: -1 },
      { code: 40301 },
      { code: 'x' },
      null,
      'x',
      {},
    ]) {
      expect(actionFailure(e)).toEqual({ reload: false, note: '' });
    }
  });
});
