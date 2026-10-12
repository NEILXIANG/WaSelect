/**
 * 职责：`admin-web/src/orders/view.ts` 的单测。
 *
 * @why 钉的全是**点了之后钱或货已经出去、才发现不该点**的动作：
 *      ① 未付款/已发货也能发货 → 重复发货，货出去了；
 *      ② 拒付进行中仍允许退款 → 服务端 40907，运营不知道为什么点不动；
 *      ③ 状态文案缺一个键 → 那一列显示"未知状态"，客服对客户说不出订单怎么了；
 *      ④ 时间/金额格式化依赖机器时区或语言区 → 两台机器显示两个数字。
 */
import type { OrderStatus } from '@waselect/shared';
import { refundGuard } from '../../../server/src/domain/admin-order-actions.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_NOTE_MAX_LENGTH,
  ORDER_STATUS,
  REFUND_REASON_MAX_LENGTH,
  SHIP_MAX_CHARS,
} from '@waselect/shared';
import {
  EVENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  addressGate,
  addressSummary,
  paymentSummary,
  emptyRefundForm,
  emptyReleaseForm,
  emptyShipForm,
  eventNoteView,
  eventRefLabel,
  eventStatusText,
  orderRows,
  PURCHASE_UNRECORDED,
  purchaseLine,
  purchaseLines,
  itemNames,
  refundErrors,
  refundFailureNotice,
  fullRefundErrorNotice,
  refundGate,
  RELEASE_DONE_NOTICE,
  releaseErrors,
  isDisputeLocked,
  shipErrors,
  shipGate,
  statusText,
  toRefundBody,
  toReleaseBody,
  toShipBody,
} from './view.js';

/** 像真的订单（约束三：真实品名、真实价位、真实美国地址与运单号形态）。 */
const ORDER = {
  order_id: 'o-2609-0013',
  order_no: 'WS-20260927-0013',
  status: 'paid',
  total_jpy: 12800,
  created_at: '2026-09-27T04:05:06Z',
  address: { recipient: 'Emily Carter', city: 'Seattle', state: 'WA' },
  carrier: '',
  tracking_no: '',
  items: [{ product_id: 'p-shiro-cleansing-oil', title: '資生堂 クレンジングオイル', qty: 1 }],
};

const withStatus = (
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...ORDER, status, ...extra });

describe('orderRows', () => {
  it('映射出列表要显示的每一列', () => {
    const [row] = orderRows([ORDER]);
    expect(row).toMatchObject({
      id: 'o-2609-0013',
      orderNo: 'WS-20260927-0013',
      status: 'paid',
      statusText: '待发货',
      totalText: '12,800 日元',
      createdText: '2026-09-27 13:05',
      recipientText: 'Emily Carter',
    });
    // 未发货：承运商与运单号都为空 → 整格空串（不是 " / "）
    expect(row?.shipText).toBe('');
  });

  it('已发货：承运商 + 运单号拼一行', () => {
    const [row] = orderRows([{ ...ORDER, carrier: 'Japan Post', tracking_no: 'EL123456789JP' }]);
    expect(row?.shipText).toBe('Japan Post / EL123456789JP');
  });

  it('⚠️ 缺 order_id 的行被丢掉（留着点了会打到 /admin/orders/undefined）', () => {
    expect(orderRows([{ order_no: 'WS-1' }, ORDER])).toHaveLength(1);
  });

  it('⚠️ 契约外状态 → "未知状态" 且三个操作全拦（不猜成某个真实状态）', () => {
    const [row] = orderRows([withStatus('weird_status')]);
    expect(row?.status).toBeNull();
    expect(row?.statusText).toBe('未知状态');
    expect(row?.actions.ship.ok).toBe(false);
    expect(row?.actions.refund.ok).toBe(false);
    expect(row?.actions.address.ok).toBe(false);
  });

  it('非数组输入给空列表（不是抛，也不是 [undefined]）', () => {
    expect(orderRows(null)).toEqual([]);
    expect(orderRows({ items: [] })).toEqual([]);
  });

  it('测试单与拒付标记原样带出（列表默认过滤是服务端的事，前端只负责标出来）', () => {
    const [row] = orderRows([{ ...ORDER, is_test: true, has_dispute: true }]);
    expect(row?.isTest).toBe(true);
    expect(row?.hasDispute).toBe(true);
  });

  it('AJ-425：售后中 / 用户已拉黑原样带出；字段缺失（旧版响应）按 false，不凭空挂徽章', () => {
    const [on] = orderRows([{ ...ORDER, after_sale_open: true, user_blocked: true }]);
    expect(on?.afterSaleOpen).toBe(true);
    expect(on?.userBlocked).toBe(true);
    const [off] = orderRows([ORDER]);
    expect(off?.afterSaleOpen).toBe(false);
    expect(off?.userBlocked).toBe(false);
  });
});

/**
 * 🔴 回归：L4 浏览器验收（2026-10-02）发现订单详情页的「状态」直接渲染 `order.status`
 *    原文（`paid`），而列表页同一张单显示「待发货」——同一个状态两个页面两种叫法。
 *    根因是"状态怎么显示"这句三元表达式只写在 `orderRows` 内部，详情页够不着。
 *    下面这组是"两处现在共用同一个答案"的钉子。
 */
describe('statusText（列表与详情共用的状态文案）', () => {
  it('十态全部给中文，且与列表行用的是同一份词表', () => {
    for (const s of ORDER_STATUS) {
      expect(statusText({ status: s }), s).toBe(ORDER_STATUS_LABELS[s]);
      // 详情页曾用 `order.status ?? '—'`，于是这一格出现服务端原文
      expect(statusText({ status: s }), s).not.toBe(s);
    }
  });

  it('🔴 详情页那一格不再显示服务端原文（缺陷注入点：改回 order.status 即红）', () => {
    expect(statusText({ status: 'paid' })).toBe('待发货');
    expect(statusText({ status: 'created' })).toBe('已下单，等待买家付款'); // AJ-410 / N15 改白话
    expect(statusText({ status: 'shipped' })).toBe('已发货');
  });

  it('契约外 / 缺失 / null 输入 → "未知状态"（不猜成某个真实状态）', () => {
    expect(statusText({ status: 'weird_status' })).toBe('未知状态');
    expect(statusText({})).toBe('未知状态');
    expect(statusText(null)).toBe('未知状态');
    expect(statusText({ status: 123 })).toBe('未知状态');
  });

  it('列表行的 statusText 与详情共用同一个函数（两处不会各自漂移）', () => {
    const [row] = orderRows([withStatus('refunding')]);
    expect(row?.statusText).toBe(statusText({ status: 'refunding' }));
  });
});

describe('eventStatusText（事件流：订单状态 + 管理事件伪状态）', () => {
  // 全入口点击测试 2026-10-11：时间线讲"那时发生了什么"——原先用状态词，付款那一行写"待发货 · 支付机构 mock"，
  // 读成"支付机构待发货"。改为事件词（覆盖十态，单测比对），与小程序时间线同一思路
  it('🔴 订单状态值 → 事件词（不是状态词；created 而不是 created 原样）', () => {
    expect(eventStatusText('created')).toBe('下单（等待买家付款）');
    // 后面紧跟「· 买家」（操作人），事件词里再写「买家」就重复了（业务旅程测试 2026-10-12 读出）
    expect(eventStatusText('pending_payment')).toBe('发起付款');
    expect(eventStatusText('paid')).toBe('付款成功（待发货）');
    expect(eventStatusText('shipped')).toBe('已发货');
    expect(eventStatusText('refunding')).toBe('开始退款');
    expect(eventStatusText('refunded')).toBe('退款完成');
    for (const s of ORDER_STATUS) expect(eventStatusText(s), s).not.toBe(s);
  });

  it('🔴 管理事件伪状态 → 中文（缺陷注入点：这里曾直接渲染 e.status 原文）', () => {
    expect(eventStatusText('address_changed')).toBe('改址');
    expect(eventStatusText('dispute_opened')).toBe('拒付开案');
    expect(eventStatusText('dispute_closed')).toBe('拒付结案');
    expect(eventStatusText('refund_pending')).toBe('退款处理中');
    expect(eventStatusText('refund_failed')).toBe('退款失败');
    expect(eventStatusText('dispute_released')).toBe('解除拒付限制');
    expect(eventStatusText('pay_create_failed')).toBe('机构拒建支付会话');
    expect(eventStatusText('partial_refunded')).toBe('部分退款成功');
    expect(eventStatusText('partial_failed')).toBe('部分退款失败');
  });

  it('十五种伪状态全部配了文案（服务端新增一种而这里没跟 → 那一行退回英文，看得见但仍是缺口）', () => {
    expect(Object.keys(EVENT_STATUS_LABELS).sort()).toEqual([
      'address_changed',
      'after_sale_handled',
      'dispute_closed',
      'dispute_opened',
      'dispute_released',
      'late_paid',
      'partial_failed',
      'partial_refunded',
      'pay_create_failed',
      'refund_failed',
      'refund_pending',
      'refunded_by_parts',
      'shipment_fixed',
      'shipment_reverted',
      'test_archived',
    ]);
  });

  it('⚠️ 认不出的值**原样返回**：不映射成"未知"，否则"发生过什么事"这层信息被吃掉', () => {
    expect(eventStatusText('some_future_event')).toBe('some_future_event');
  });

  it('空 / 非字符串 → 空串（时间线那一行不该出现 "undefined"）', () => {
    expect(eventStatusText('')).toBe('');
    expect(eventStatusText(undefined)).toBe('');
    expect(eventStatusText(null)).toBe('');
    expect(eventStatusText(42)).toBe('');
  });

  it('伪状态文案两两不同（合并了就分不清改址与拒付）', () => {
    const labels = Object.values(EVENT_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('addressSummary / paymentSummary', () => {
  it('地址按美式顺序拼一行', () => {
    expect(addressSummary(ORDER)).toBe('Emily Carter，Seattle，WA');
  });

  it('⚠️ line2 为空时不留空逗号（"Seattle，，WA" 会被当成漏字段）', () => {
    expect(
      addressSummary({ address: { ...ORDER.address, line1: '500 Union St', line2: '' } }),
    ).toBe('Emily Carter，500 Union St，Seattle，WA');
  });

  it('⚠️ 完全没地址给占位符（空白会让人以为页面坏了）', () => {
    expect(addressSummary({})).toBe('—');
    expect(addressSummary(null)).toBe('—');
  });

  it('支付行给出通道 + 原币扣款额', () => {
    expect(
      paymentSummary({
        payment: { channel: 'stripe', charge_currency: 'USD', charge_amount: 8600 },
      }),
    ).toBe('stripe · $86.00');
  });

  it('⚠️ 缺 amount 时不显示 "USD undefined"（缺值不许拼出一个假金额）', () => {
    expect(paymentSummary({ payment: { channel: 'wechat', charge_currency: 'JPY' } })).toBe(
      'wechat',
    );
    expect(paymentSummary({})).toBe('—');
  });
});

describe('shipGate（发货闸门）', () => {
  it('只有 paid 可发货', () => {
    expect(shipGate(withStatus('paid')).ok).toBe(true);
    for (const s of ORDER_STATUS.filter((x) => x !== 'paid')) {
      const g = shipGate(withStatus(s));
      expect(g.ok, `${s} 不该能发货`).toBe(false);
      expect(g.reason, `${s} 缺禁用原因`).not.toBe('');
    }
  });

  it('⚠️ 拒付进行中 → 拦（发货后钱货两空；这是前端口径，服务端目前不拦）', () => {
    const g = shipGate(withStatus('paid', { has_dispute: true }));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('拒付');
  });

  it('未付款给的原因指向"付款"而不是笼统的"不能操作"', () => {
    expect(shipGate(withStatus('created')).reason).toContain('未付款');
  });

  it('审核期测试单（is_test）→ 拦，原因写明"测试单"（与服务端 shipGuard 同口径，AJ-179）', () => {
    const g = shipGate(withStatus('paid', { is_test: true }));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('测试单');
  });
});

describe('orderRows：查件链接（剩余清单 3-5）', () => {
  it('🔴 有 https 的 tracking_url → trackingUrl；缺失或非 https → 空串', () => {
    const url = 'https://trackings.post.japanpost.jp/services/srv/search?requestNo1=EM123456789JP';
    const [a, b, c] = orderRows([
      { order_id: 'o-1', status: 'shipped', tracking_no: 'EM123456789JP', tracking_url: url },
      { order_id: 'o-2', status: 'shipped', tracking_no: 'X' },
      { order_id: 'o-3', status: 'shipped', tracking_url: 'javascript:alert(1)' },
    ]);
    expect(a?.trackingUrl).toBe(url);
    expect(b?.trackingUrl).toBe('');
    expect(c?.trackingUrl).toBe('');
  });
});

describe('refundGate（退款闸门）', () => {
  it('paid / shipped / delivered 可退', () => {
    for (const s of ['paid', 'shipped', 'delivered'] as const) {
      expect(refundGate(withStatus(s)).ok, `${s} 应可退`).toBe(true);
    }
  });

  it('⚠️ 未付款 → 拦且原因指向"取消"不是"退款"（没付过的钱没有可退记录）', () => {
    const g = refundGate(withStatus('pending_payment'));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('取消');
  });

  /**
   * KD-12：服务端允许对停在 refunding 的单再提交，前端不能把唯一入口堵死。
   * ⚠️ 文案按契约 0.6.11 / F-03（AJ-178）的**三种**情形说（B41 / AJ-215）：
   *    在途→只查询 / 确认失败→换新键重发 / 结果未知→沿用同键。
   *    旧文案"同一幂等键不会退两次"只覆盖第三种，运营照它理解第二种会以为"再点也白点"，
   *    而第二种恰恰是必须再点的那一种。
   */
  it('⚠️ refunding 放行，且文案覆盖三种情形（不只说"重试"）', () => {
    const g = refundGate(withStatus('refunding'));
    expect(g.ok).toBe(true);
    expect(g.reason).toContain('查询');
    expect(g.reason).toContain('不会重复退两次');
    // 🔴 不许再说"同一幂等键"——确认失败时服务端会**换新键**重新发起，那句是错的
    expect(g.reason).not.toContain('同一幂等键');
  });

  it('列表行收件人：取顶层 recipient（列表形状，0.6.9），缺失时回落 address.recipient（详情形状）', () => {
    const list = orderRows([{ order_id: 'o-1', status: 'paid', recipient: 'Jane Doe' }]);
    expect(list[0]?.recipientText).toBe('Jane Doe');
    const detail = orderRows([{ order_id: 'o-2', status: 'paid', address: { recipient: 'Taro' } }]);
    expect(detail[0]?.recipientText).toBe('Taro');
  });

  // AJ-410：行为变更——原因不再带内部错误码 40907（运营看不懂），改为白话说清"为什么"和"去哪处理"
  it('⚠️ has_dispute=true 拦，原因用白话说清是拒付、去哪处理（不带错误码）', () => {
    const g = refundGate(withStatus('paid', { has_dispute: true }));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('拒付');
    expect(g.reason).toContain('风控');
    expect(g.reason).not.toMatch(/\d{5}/);
  });

  it('⚠️ has_dispute 字段缺失时放行（列表接口没有这个字段，拦了正常单也点不动）', () => {
    expect(refundGate(withStatus('paid')).ok).toBe(true);
  });

  it('🔴 迟到付款（late_paid=true）的 expired / cancelled → 放行，原因说明"关单后才收到钱"（1-5）', () => {
    for (const s of ['expired', 'cancelled'] as const) {
      const g = refundGate(withStatus(s, { late_paid: true }));
      expect(g.ok, `${s} 带凭据应可退`).toBe(true);
      expect(g.reason).toContain('关闭后');
    }
    // 凭据只对已关单有意义：refunded 带它也不放行
    expect(refundGate(withStatus('refunded', { late_paid: true })).ok).toBe(false);
  });

  // 统一结论 5.4：被拦的原因写在操作条**下方**，「部分退款…」按钮就在操作条**里**——说"下方"是指错了方向
  it('🔴 已完成的单：原因指向操作条里的「部分退款…」，不说"下方"', () => {
    const g = refundGate(withStatus('completed'));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('操作条里的「部分退款…」');
    expect(g.reason).not.toContain('下方');
  });

  it('终态（cancelled / expired / refunded / completed）全拦且有原因', () => {
    for (const s of ['cancelled', 'expired', 'refunded', 'completed'] as const) {
      const g = refundGate(withStatus(s));
      expect(g.ok).toBe(false);
      expect(g.reason).not.toBe('');
    }
  });
});

describe('addressGate（改址闸门）', () => {
  it('仅 paid 可改址（契约：发货前）', () => {
    expect(addressGate(withStatus('paid')).ok).toBe(true);
    expect(addressGate(withStatus('shipped')).ok).toBe(false);
    expect(addressGate(withStatus('created')).ok).toBe(false);
  });

  it('禁用原因里带上当前状态（运营要知道"为什么现在不能改"）', () => {
    expect(addressGate(withStatus('delivered')).reason).toContain('已签收');
  });

  // 业务旅程测试 2026-10-12：已退款 / 超时关闭的单也写着"已发货改址要联系承运商"——那句只对已发货的单有用
  it('🔴 只有已发货的单才提"联系承运商"；已退款 / 超时关闭 / 待付款不提', () => {
    expect(addressGate(withStatus('shipped')).reason).toContain('联系承运商');
    for (const s of ['refunded', 'expired', 'cancelled', 'created', 'pending_payment']) {
      expect(addressGate(withStatus(s)).reason, s).not.toContain('承运商');
    }
    expect(addressGate(withStatus('expired')).reason).toBe('仅"待发货"可改址（当前：超时关闭）');
  });
});

describe('发货 / 退款表单', () => {
  it('空表单两条错误一起返回（不是报完一条再报下一条）', () => {
    const r = shipErrors(emptyShipForm());
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['carrier', 'trackingNo']);
  });

  it('trim 后的空白也算没填（" " 会让服务端收到一个空格当运单号）', () => {
    expect(shipErrors({ carrier: 'Japan Post', trackingNo: '   ' }).ok).toBe(false);
  });

  /**
   * @why 这条与上一条的区别是关键：上面那条断言的是 `errors`（早已正确），
   *      而界面读的一直是 `first`——两格都空时只冒「承运商必填」，
   *      改完再点才蹦出「运单号必填」。函数对、串起来的那一层错，测试一样全绿。
   *      所以这里补的是**界面真正消费的出口** `summary`。
   */
  it('🔴 summary 一次带上全部错误（界面只读它，不再读 first）', () => {
    const r = shipErrors(emptyShipForm());
    expect(r.summary).toContain('承运商必填');
    expect(r.summary).toContain('运单号必填');
    expect(r.summary.split('；')).toHaveLength(2);
    // 只错一格时 summary == first，两者不该互相矛盾
    const one = shipErrors({ carrier: 'Japan Post', trackingNo: '' });
    expect(one.summary).toBe(one.first);
    expect(shipErrors({ carrier: 'Japan Post', trackingNo: 'EL123' }).summary).toBe('');
  });

  it('⚠️ toShipBody 换成服务端键名 tracking_no（写成 trackingNo 服务端会 40001）', () => {
    expect(toShipBody({ carrier: ' Japan Post ', trackingNo: ' EL123 ' })).toEqual({
      carrier: 'Japan Post',
      tracking_no: 'EL123',
    });
  });

  it('退款原因必填，非空即通过（不设最短长度：会逼人填满 aaaa）', () => {
    expect(refundErrors(emptyRefundForm()).ok).toBe(false);
    expect(refundErrors({ reason: '缺货' }).ok).toBe(true);
    expect(toRefundBody({ reason: ' 缺货 ' })).toEqual({ reason: '缺货' });
  });

  /**
   * B7 / AJ-191：**最长**必须有（最短故意没有）。
   * @why 边界值由 shared 常量算出，不在测试里再写一遍 500——写两遍就等于两处都能改、
   *      改一处另一处不红（契约 / 服务端 / 前端三个 500 各自漂移正是这条要防的）。
   * @why 同时断言"提示语里带上限数字"：运营看到的错误必须告诉他**上限是多少**，
   *      否则他只知道"不能提交"，不知道该删到多短。
   */
  it(`退款原因超过 ${String(REFUND_REASON_MAX_LENGTH)} 字 → 拦下，且提示带上限数字`, () => {
    const MAX = REFUND_REASON_MAX_LENGTH;
    expect(refundErrors({ reason: '理'.repeat(MAX) }).ok).toBe(true);
    const tooLong = refundErrors({ reason: '理'.repeat(MAX + 1) });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.first).toContain(String(MAX));
  });

  /**
   * 🔴 AJ-315（第二轮审查 B24）：上限与服务端**同一个常量**（`SHIP_MAX_CHARS`），
   * 所以"前端放行、服务端拒"这个形态结构上不可能出现——写死 32 / 64 就是第三份。
   */
  it(`承运商超过 ${String(SHIP_MAX_CHARS.carrier)} 字 → 拦下，提示带上限数字`, () => {
    const at = shipErrors({ carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier), trackingNo: 'EL123' });
    expect(at.ok).toBe(true);
    const over = shipErrors({ carrier: 'C'.repeat(SHIP_MAX_CHARS.carrier + 1), trackingNo: 'EL1' });
    expect(over.ok).toBe(false);
    expect(over.errors['carrier']).toContain(String(SHIP_MAX_CHARS.carrier));
  });

  it(`运单号超过 ${String(SHIP_MAX_CHARS.tracking_no)} 字 → 拦下，提示带上限数字`, () => {
    const at = shipErrors({
      carrier: 'Japan Post',
      trackingNo: 'T'.repeat(SHIP_MAX_CHARS.tracking_no),
    });
    expect(at.ok).toBe(true);
    const over = shipErrors({
      carrier: 'Japan Post',
      trackingNo: 'T'.repeat(SHIP_MAX_CHARS.tracking_no + 1),
    });
    expect(over.ok).toBe(false);
    expect(over.errors['trackingNo']).toContain(String(SHIP_MAX_CHARS.tracking_no));
  });

  it('非对象输入当作空表单（不是抛，也不是 undefined 穿透）', () => {
    expect(shipErrors(null).ok).toBe(false);
    expect(refundErrors(undefined).ok).toBe(false);
    expect(toShipBody(undefined)).toEqual({ carrier: '', tracking_no: '' });
  });
});

/**
 * ⚠️ 与契约的双向比对：管理端词表的键必须**恰好等于** `OrderStatus` 的 enum。
 * @why 服务端新增状态而管理端没跟进的表现是：那一列显示"未知状态"，
 *      而且**三个操作按钮同时变灰**——运营看不出是"这单不能操作"还是"系统坏了"。
 */
describe('ORDER_STATUS_LABELS 与契约 OrderStatus 的双向比对', () => {
  const yaml = readFileSync(resolve(__dirname, '../../../contracts/api-contract.yaml'), 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('OrderStatus: {')) ?? '';
  const enumLine = line.slice(line.indexOf('enum:'));
  const contractStatuses = (enumLine.match(/[a-z_]+/g) ?? []).filter((w) => w !== 'enum');

  it('抽到了 OrderStatus 的 enum（契约改写成多行会失配）', () => {
    expect(line).toContain('OrderStatus');
    expect(contractStatuses.length).toBe(ORDER_STATUS.length);
  });

  it('两边集合相等：契约有而词表没有 → 静默显示"未知状态" + 按钮全灰', () => {
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual([...contractStatuses].sort());
  });

  it('⚠️ 十态文案两两不同（合并了就等于退回买家视角，客服分辨不出"没发起"和"支付中"）', () => {
    const labels = Object.values(ORDER_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/**
 * 「人工解除拒付限制」的入口判据与表单（B1b / AJ-194 的前端落地，AJ-291）。
 *
 * @why 单独一组而不是并进"发货 / 退款表单"：这个动作**不可逆且没有反向接口**
 *      （契约只有 release，没有 re-lock），它的闸门判反了的表现不是"点不动"，
 *      而是"对一张没锁的订单点了解除"——服务端会响亮失败 40902，
 *      但更糟的是将来有人把它加进列表页逐行按钮时的"点错单号"。
 */
describe('isDisputeLocked / releaseErrors（解除拒付限制，AJ-291）', () => {
  it('🔴 只有 has_dispute === true 才给入口（没锁的单不出现按钮）', () => {
    expect(isDisputeLocked(withStatus('paid', { has_dispute: true }))).toBe(true);
    expect(isDisputeLocked(withStatus('paid', { has_dispute: false }))).toBe(false);
    // ⚠️ 字段缺失**不放行**（与 refundGate 的"缺失即放行"相反）：解除不可逆，
    //    在不知道有没有锁的时候给按钮 = 把不可逆动作变成试错。
    expect(isDisputeLocked(withStatus('paid'))).toBe(false);
    expect(isDisputeLocked(withStatus('paid', { has_dispute: 'true' }))).toBe(false);
    expect(isDisputeLocked(null)).toBe(false);
  });

  it('不按订单状态分叉：拒付可能开在 paid，也可能开在已退款之后协商和好', () => {
    for (const status of ORDER_STATUS) {
      expect(isDisputeLocked(withStatus(status, { has_dispute: true })), status).toBe(true);
      expect(isDisputeLocked(withStatus(status, { has_dispute: false })), status).toBe(false);
    }
  });

  it('理由必填（无理由的解锁在审计里是一条说不清的记录）', () => {
    expect(releaseErrors(emptyReleaseForm()).ok).toBe(false);
    expect(releaseErrors({ reason: '   ' }).ok).toBe(false);
    expect(releaseErrors({ reason: '机构已结案但漏发事件' }).ok).toBe(true);
    expect(toReleaseBody({ reason: ' 已与买家协商和好 ' })).toEqual({ reason: '已与买家协商和好' });
  });

  it(`理由上限 ${String(ADMIN_NOTE_MAX_LENGTH)} 字由 shared 常量算出（不写死 500）`, () => {
    const MAX = ADMIN_NOTE_MAX_LENGTH;
    expect(releaseErrors({ reason: '理'.repeat(MAX) }).ok).toBe(true);
    const tooLong = releaseErrors({ reason: '理'.repeat(MAX + 1) });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.first).toContain(String(MAX));
  });

  it('脏输入当作空表单（不抛，也不让 undefined 穿透）', () => {
    expect(releaseErrors(null).ok).toBe(false);
    expect(releaseErrors(undefined).ok).toBe(false);
    expect(toReleaseBody(undefined)).toEqual({ reason: '' });
  });

  it('🔴 成功提示必须说清"拒付**没有**结案"（否则运营会理解成"处理完了"就发货）', () => {
    // @why 这条是文案断言，不是格式化检查：解除之后发货闸门立刻打开，
    //      而"以为拒付已结案 → 发货"正是钱货两空的标准路径。
    expect(RELEASE_DONE_NOTICE).toContain('没有结案');
    expect(RELEASE_DONE_NOTICE).toContain('风控列表');
    expect(RELEASE_DONE_NOTICE).toContain('不要因为按钮亮了就发');
  });
});

describe('refundFailureNotice（B41 残留 / AJ-230）', () => {
  it('🔴 5xx 与网络层失败（负数码）→ 给"结果未知、不要去机构后台手工退"的提醒', () => {
    for (const code of [50000, -1]) {
      const text = refundFailureNotice(code);
      expect(text, String(code)).toContain('结果未知');
      expect(text, String(code)).toContain('不要去机构后台手工退款');
      expect(text, String(code)).toContain('不会重复退款');
    }
  });

  it('P2-49 50300（熔断，请求未发出）单独说，带退避秒数；没秒数不编', () => {
    expect(refundFailureNotice(50300, 5)).toBe('上游暂时不可用，请求未发出，约 5 秒后可重试');
    expect(refundFailureNotice(50300)).toBe('上游暂时不可用，请求未发出，请稍后重试');
  });

  it('4xx 业务性拒绝 → 不提醒（订单没被改动，提醒反而误导）', () => {
    for (const code of [40001, 40101, 40902, 40907, 42901]) {
      expect(refundFailureNotice(code), String(code)).toBe('');
    }
  });

  it('脏输入（不是数字）→ 不提醒、不抛', () => {
    expect(refundFailureNotice(undefined)).toBe('');
    expect(refundFailureNotice('50000')).toBe('');
  });
});

describe('fullRefundErrorNotice（P2-49：出错后按刷新后的真实状态说话）', () => {
  const refunding = (events: unknown[]): unknown => ({ status: 'refunding', events });

  it('机构确认失败（refund_failed + provider_failed:…）→ 说可重新发起', () => {
    const t = fullRefundErrorNotice({
      code: 50000,
      order: refunding([{ status: 'refund_failed', note: 'provider_failed:re_123' }]),
    });
    expect(t).toContain('机构确认失败');
  });

  it('机构超时（provider_error）/ 没有事件 → 结果未知，不要去 Stripe 后台重复退', () => {
    for (const ev of [[{ status: 'refund_failed', note: 'provider_error' }], []]) {
      const t = fullRefundErrorNotice({ code: -1, order: refunding(ev) });
      expect(t).toContain('结果未知');
      expect(t).toContain('不要去 Stripe 后台重复退');
    }
  });

  it('刷新后已 refunded → 说已完成；4xx → 不提醒；50300 → 未发出', () => {
    expect(fullRefundErrorNotice({ code: 50000, order: { status: 'refunded' } })).toContain(
      '实际已完成',
    );
    expect(fullRefundErrorNotice({ code: 40907, order: refunding([]) })).toBe('');
    expect(
      fullRefundErrorNotice({ code: 50300, retryAfterSec: 3, order: refunding([]) }),
    ).toContain('约 3 秒后可重试');
  });
});

describe('purchaseLine（D-39 待采购清单 / 迁移 021）', () => {
  it('三样齐全 → 一行带标签的小字', () => {
    expect(
      purchaseLine({
        title_ja: '南部鉄器 急須 0.6L',
        jan_code: '4901234567890',
        purchase_source: '楽天 南部鉄器本店',
      }),
    ).toBe('日文原名：南部鉄器 急須 0.6L · JAN：4901234567890 · 采购来源：楽天 南部鉄器本店');
  });

  it('🔴 缺的字段显示「未记录」，不是省略（运营要能分清"商品没有"和"系统没记"）', () => {
    const line = purchaseLine({ jan_code: '4901234567890' });
    expect(line).toContain('日文原名：未记录');
    expect(line).toContain('JAN：4901234567890');
    expect(line).toContain('采购来源：未记录');
  });

  it('🔴 三样全缺 → 说清"这单建于采购信息录入之前"（不是三个「未记录」摞一起）', () => {
    // @why 迁移 021 刻意不回填历史行，所以"全空"几乎只可能来自老订单。
    //      写清原因，运营就不会以为系统漏了、也不会逐件去补商品（那补不上）。
    const line = purchaseLine({ product_id: 'p-1', title: '急須' });
    expect(line).toContain('未记录采购信息');
    expect(line).toContain('建于采购信息录入之前');
    expect(line).not.toContain('日文原名：');
  });

  it('空串 / 纯空格当没记录（脏数据不显示成一个空的「JAN：」）', () => {
    // ⚠️ 必须留一个**有效**字段：三样都无效会走"全缺"分支（那是下一条用例的事），
    //    这里要验的是"部分有效时，无效的那一格显示什么"。
    expect(purchaseLine({ title_ja: '急須', jan_code: '' })).toContain('JAN：未记录');
    expect(purchaseLine({ title_ja: '急須', jan_code: '   ' })).toContain('JAN：未记录');
    // 纯空格的 title_ja 同样不算有值
    expect(purchaseLine({ title_ja: '  ', jan_code: '4901234567890' })).toContain(
      '日文原名：未记录',
    );
  });

  it('脏输入（null / 非对象）→ 走"全缺"那条，不抛', () => {
    expect(purchaseLine(undefined)).toContain('未记录采购信息');
    expect(purchaseLine(null)).toContain('未记录采购信息');
    expect(purchaseLine('x')).toContain('未记录采购信息');
  });

  it('🧷 采购来源是**内部信息**：只在本函数的输出里，买家侧 OrderItem 没有这一列', () => {
    // @why 这是一条**形状**断言而不是行为断言：契约把采购三列收在 AdminOrderItem，
    //      买家 OrderItem 不带；本用例钉住"这里确实会显示它"（它是管理端唯一消费方），
    //      顺带提醒改契约的人：给买家加上这一列 = 泄露供应链。
    expect(PURCHASE_UNRECORDED).toBe('未记录');
    expect(purchaseLine({ purchase_source: '京都 錦市場 直送' })).toContain('京都 錦市場 直送');
  });
});

// 两端逐页走查 2026-10-12：列表"采购信息"一格只有日文原名 / JAN / 采购来源——没有中文名，也没有件数，
//   采购员看不出这单要买几件；全部 / 已发货页签里运营也看不出卖了什么
describe('itemNames：列表每个商品一行"中文名 × 件数"', () => {
  it('🔴 按 items 顺序给出名称与件数；缺名称写「（商品名缺失）」不留空', () => {
    expect(
      itemNames({
        items: [
          { title: '卡乐比 拌饭料 6 种', qty: 2 },
          { title: '无印良品 敏感肌乳液 200mL', qty: 1 },
          { qty: 3 },
        ],
      }),
    ).toEqual(['卡乐比 拌饭料 6 种 × 2', '无印良品 敏感肌乳液 200mL × 1', '（商品名缺失） × 3']);
    expect(itemNames({ order_id: 'o-1' })).toEqual([]);
  });
});

describe('purchaseLines（0.6.26：列表页也要有采购信息）', () => {
  /**
   * @why 单独为列表那一层写用例，是因为 `purchaseLines` 有自己的失效形态：
   *      `purchaseLine` 全绿并不能保证"列表拿得到"——列表要先从订单条目里
   *      取出 `items` 数组再逐行映射。取错键（比如读 `order_items` 或 `lines`）
   *      不会报错，只会**静默返回 []**，列表页整列变成"—"，
   *      而采购员看到的是"今天没有要买的东西"。
   */
  it('多行的订单 → 每行一条，顺序与 items 一致', () => {
    const lines = purchaseLines({
      order_id: 'o-1',
      items: [
        {
          title: '包丁',
          title_ja: 'シェフナイフ',
          jan_code: '4900000000011',
          purchase_source: 'Amazon JP',
        },
        { title: '茶碗', purchase_source: '楽天市場' },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Amazon JP');
    expect(lines[0]).toContain('4900000000011');
    expect(lines[1]).toContain('楽天市場');
    // 第二行缺日文原名与 JAN → 那两格显示「未记录」，但**不能**走"全缺"那条
    expect(lines[1]).toContain('日文原名：未记录');
    expect(lines[1]).not.toContain('建于采购信息录入之前');
  });

  it('没有 items / items 不是数组 → []（列表显示"—"，不抛、不显示占位话术）', () => {
    expect(purchaseLines({ order_id: 'o-1' })).toEqual([]);
    expect(purchaseLines({ order_id: 'o-1', items: null })).toEqual([]);
    expect(purchaseLines({ order_id: 'o-1', items: 'x' })).toEqual([]);
    expect(purchaseLines(null)).toEqual([]);
    expect(purchaseLines({ order_id: 'o-1', items: [] })).toEqual([]);
  });

  it('🧷 与详情同口径：列表的每一行就是 purchaseLine 的输出（不另写一套短版）', () => {
    // @why 两份话术的分歧是静默的——列表说「未记录」、详情说「这单建于…之前」，
    //      运营在两个页面得到的信息不一致，而两份各自都有用例，没人会红。
    const item = { title: '急須', title_ja: '急須', jan_code: '4901234567890' };
    expect(purchaseLines({ items: [item] })[0]).toBe(purchaseLine(item));
    expect(purchaseLines({ items: [{}] })[0]).toBe(purchaseLine({}));
  });
});

describe('orderRows 带 purchaseLines（0.6.26）', () => {
  it('列表行直接带上采购信息；缺 items 的行是空数组', () => {
    const rows = orderRows([
      {
        order_id: 'o-1',
        order_no: 'NO-1',
        status: 'paid',
        items: [{ title: '包丁', purchase_source: 'Amazon JP' }],
      },
      { order_id: 'o-2', order_no: 'NO-2', status: 'paid' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.purchaseLines).toEqual([
      purchaseLine({ title: '包丁', purchase_source: 'Amazon JP' }),
    ]);
    expect(rows[0]?.purchaseLines[0]).toContain('Amazon JP');
    expect(rows[1]?.purchaseLines).toEqual([]);
  });
});

/**
 * 退款闸门与服务端 `refundGuard` 逐格对照（A-01）。
 * @why 服务端先放行 `refunding`、再判拒付（拒付期间仍允许查询在途那笔 / 同键重放，
 *      换新键重新发起由 refund-execution 拦）。前端原来先判拒付，`refunding + 拒付` 的单按钮被锁死，
 *      订单永远停在退款中。两端顺序不一致只能靠逐格对照发现。
 */
describe('refundGate 与服务端 refundGuard 逐格一致（A-01）', () => {
  it.each(
    ORDER_STATUS.flatMap((s) => [
      [s, false],
      [s, true],
    ]) as Array<[OrderStatus, boolean]>,
  )('status=%s has_dispute=%s', (status, dispute) => {
    expect(refundGate(withStatus(status, { has_dispute: dispute })).ok).toBe(
      refundGuard(status, dispute).ok,
    );
  });
});

describe('eventNoteView：处理售后事件（三端模拟测试 2026-10-11，用户截图指出）', () => {
  it('🔴 结尾的「（售后 #uuid）」挪进 ref，正文只留处理结果与说明；认不出原样返回', () => {
    expect(
      eventNoteView(
        'after_sale_handled',
        '已处理：已退断裂那一支唇膏的货款 3,780 円。（售后 #ab72c24e-7e8e-4d77-af80-70864eecccfd）',
      ),
    ).toEqual({
      text: '已处理：已退断裂那一支唇膏的货款 3,780 円。',
      ref: 'ab72c24e-7e8e-4d77-af80-70864eecccfd',
    });
    expect(eventNoteView('after_sale_handled', '处理中（售后 #a-1）')).toEqual({
      text: '处理中',
      ref: 'a-1',
    });
    expect(eventNoteView('after_sale_handled', '处理中')).toEqual({ text: '处理中', ref: '' });
  });

  it('🔴 迟到付款 / 已退款的 note 是支付机构流水号（一整串机器号）→ 挪进 ref；悬停标签按事件种类给', () => {
    expect(eventNoteView('late_paid', 'mock_2acc0478-2bbc-41da-83b8-0bbeb4fad111')).toEqual({
      text: '',
      ref: 'mock_2acc0478-2bbc-41da-83b8-0bbeb4fad111',
    });
    expect(eventNoteView('refunded', 're_3PqXyZ123456')).toEqual({
      text: '',
      ref: 're_3PqXyZ123456',
    });
    // 有空格 / 中文的是人写的说明，不动
    expect(eventNoteView('refunded', '买家要求取消')).toEqual({ text: '买家要求取消', ref: '' });
    expect(eventRefLabel('after_sale_handled')).toBe('售后编号');
    expect(eventRefLabel('late_paid')).toBe('支付流水号');
    expect(eventRefLabel('refunded')).toBe('退款流水号');
    expect(eventRefLabel('partial_refunded')).toBe('退款编号');
  });
});

describe('eventNoteView（部分退款事件的机器串 → 人话，验收 2026-10-08）', () => {
  it('三种形状翻成金额 / 原因，退款编号进 ref；认不出原样返回', () => {
    expect(eventNoteView('partial_refunded', 'rf-1:JPY:500')).toEqual({
      text: '500 日元',
      ref: 'rf-1',
    });
    expect(eventNoteView('partial_refunded', 'rf-2:USD:1234')).toEqual({
      text: '$12.34',
      ref: 'rf-2',
    });
    expect(eventNoteView('partial_failed', 'rf-3:provider_failed')).toEqual({
      text: '支付机构确认失败',
      ref: 'rf-3',
    });
    expect(eventNoteView('refunded_by_parts', 'JPY:13750')).toEqual({
      text: '累计 13,750 日元',
      ref: '',
    });
    // 认不出的形状 / 未知币种 / 其它事件：原样，不吞信息
    expect(eventNoteView('partial_refunded', 'rf-4:XXX:500')).toEqual({
      text: 'rf-4:XXX:500',
      ref: '',
    });
    expect(eventNoteView('address_changed', 'by admin')).toEqual({ text: 'by admin', ref: '' });
    expect(eventNoteView('paid', undefined)).toEqual({ text: '', ref: '' });
  });
});

describe('eventNoteView：服务端写死的英文备注 → 中文（三端联动模拟 2026-10-10）', () => {
  // 时间线里原样出现"已签收 buyer_confirmed""已退款 refunded_by_parts"：中文后台里夹英文代号，新手运营读不懂
  it('🔴 买家确认收货 / 系统自动签收、自动完成 / 部分退款退满', () => {
    expect(eventNoteView('delivered', 'buyer_confirmed')).toEqual({
      text: '买家确认收货',
      ref: '',
    });
    expect(eventNoteView('delivered', 'auto:14d')).toEqual({
      text: '发货满 14 天买家未确认，系统自动签收',
      ref: '',
    });
    expect(eventNoteView('completed', 'auto:7d')).toEqual({
      text: '签收满 7 天，系统自动完成',
      ref: '',
    });
    expect(eventNoteView('refunding', 'refunded_by_parts')).toEqual({
      text: '部分退款累计已退满整单',
      ref: '',
    });
    expect(eventNoteView('refunded', 'refunded_by_parts')).toEqual({
      text: '部分退款累计已退满整单',
      ref: '',
    });
  });

  it('只认对应的事件：同样的字样出现在别的事件 / 运营手写的备注里，原样不动', () => {
    expect(eventNoteView('refunding', 'buyer_confirmed')).toEqual({
      text: 'buyer_confirmed',
      ref: '',
    });
    expect(eventNoteView('shipped', 'auto:14d')).toEqual({ text: 'auto:14d', ref: '' });
    expect(eventNoteView('delivered', 'auto:xd')).toEqual({ text: 'auto:xd', ref: '' });
  });

  describe('G1（AJ-456）：整单退款闸门看部分退款在途；40902 的 data.reason 转成下一步', () => {
    it('有一笔部分退款在途 → 不放行并说"先同步"；只有已成功 / 失败的 → 放行', () => {
      const base = { status: 'paid', has_dispute: false };
      expect(refundGate({ ...base, partial_refunds: [{ status: 'pending' }] }).ok).toBe(false);
      expect(refundGate({ ...base, partial_refunds: [{ status: 'pending' }] }).reason).toContain(
        '同步',
      );
      expect(refundGate({ ...base, partial_refunds: [{ status: 'initiated' }] }).ok).toBe(false);
      expect(
        refundGate({ ...base, partial_refunds: [{ status: 'succeeded' }, { status: 'failed' }] })
          .ok,
      ).toBe(true);
    });
    it('refundFailureNotice 按 reason 给出下一步：in_flight → 去部分退款点同步；fully_refunded_by_partials → 已退满', () => {
      expect(refundFailureNotice(40902, undefined, 'partial_refund_in_flight')).toContain('同步');
      expect(refundFailureNotice(40902, undefined, 'fully_refunded_by_partials')).toContain('退满');
      expect(refundFailureNotice(40902)).toBe('');
    });
  });
});
