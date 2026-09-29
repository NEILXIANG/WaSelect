/**
 * 职责：`admin-web/src/orders/view.ts` 的单测。
 *
 * @why 钉的全是**点了之后钱或货已经出去、才发现不该点**的动作：
 *      ① 未付款/已发货也能发货 → 重复发货，货出去了；
 *      ② 拒付进行中仍允许退款 → 服务端 40907，运营不知道为什么点不动；
 *      ③ 状态文案缺一个键 → 那一列显示"未知状态"，客服对客户说不出订单怎么了；
 *      ④ 时间/金额格式化依赖机器时区或语言区 → 两台机器显示两个数字。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS, REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import {
  ORDER_STATUS_LABELS,
  STATUS_FILTER_OPTIONS,
  addressGate,
  addressSummary,
  paymentSummary,
  emptyRefundForm,
  emptyShipForm,
  orderRows,
  refundErrors,
  refundGate,
  shipErrors,
  shipGate,
  toRefundBody,
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
      totalText: '12,800 円',
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
    ).toBe('stripe · USD 8600');
  });

  it('⚠️ 缺 amount 时不显示 "USD undefined"', () => {
    expect(paymentSummary({ payment: { channel: 'wechat', charge_currency: 'JPY' } })).toBe(
      'wechat · JPY',
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

  it('⚠️ refunding 放行为**重试**并说明（KD-12：服务端允许重试，前端不能把唯一入口堵死）', () => {
    const g = refundGate(withStatus('refunding'));
    expect(g.ok).toBe(true);
    expect(g.reason).toContain('重试');
    expect(g.reason).toContain('不会退两次');
  });

  it('列表行收件人：取顶层 recipient（列表形状，0.6.9），缺失时回落 address.recipient（详情形状）', () => {
    const list = orderRows([{ order_id: 'o-1', status: 'paid', recipient: 'Jane Doe' }]);
    expect(list[0]?.recipientText).toBe('Jane Doe');
    const detail = orderRows([{ order_id: 'o-2', status: 'paid', address: { recipient: 'Taro' } }]);
    expect(detail[0]?.recipientText).toBe('Taro');
  });

  it('⚠️ has_dispute=true 拦且原因带 40907（服务端就是这么拒的，文案要能自查）', () => {
    const g = refundGate(withStatus('paid', { has_dispute: true }));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('40907');
  });

  it('⚠️ has_dispute 字段缺失时放行（列表接口没有这个字段，拦了正常单也点不动）', () => {
    expect(refundGate(withStatus('paid')).ok).toBe(true);
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

  it('筛选选项覆盖全部状态 + 全部（少一个就筛不出来）', () => {
    expect(STATUS_FILTER_OPTIONS).toHaveLength(ORDER_STATUS.length + 1);
    expect(STATUS_FILTER_OPTIONS[0]?.value).toBe('all');
  });
});
