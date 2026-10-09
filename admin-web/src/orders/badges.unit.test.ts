/**
 * 职责：订单徽章口径（AJ-400）——列表一枚、详情"支付 + 履约 + 标记"。
 * @see ./badges.ts
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import { detailBadges, flagBadges, statusBadge } from './badges.js';

describe('statusBadge（列表）', () => {
  /**
   * 🔴 十态**逐一精确断言文案 + 色调**，不只测"不是未知状态"。
   * @why 只测 `.text !== '未知状态'` 挡不住"文案/色调错位"：把 shipped 错映射成"已退款"、
   *      把 refunded 错映射成 warn，这行循环照样绿，而列表页那一列显示成错误状态。
   *      精确断言让"任何一态的文案或色调写错"都直接红。
   */
  it('十态文案与色调逐一精确（对 ORDER_STATUS_LABELS / TONE）', () => {
    const expected: Readonly<Record<string, { text: string; tone: string }>> = {
      created: { text: '已下单，等待买家付款', tone: 'neutral' },
      pending_payment: { text: '买家正在付款', tone: 'neutral' },
      paid: { text: '待发货', tone: 'warn' },
      shipped: { text: '已发货', tone: 'info' },
      delivered: { text: '已签收', tone: 'info' },
      completed: { text: '已完成', tone: 'success' },
      cancelled: { text: '已取消', tone: 'muted' },
      expired: { text: '已过期', tone: 'muted' },
      refunding: { text: '退款中', tone: 'warn' },
      refunded: { text: '已退款', tone: 'muted' },
    };
    for (const s of ORDER_STATUS) {
      expect(statusBadge({ status: s }), `状态 ${s} 的徽章错`).toEqual(expected[s]);
    }
  });
  it('认不出的状态 → 未知状态（不抛）', () => {
    expect(statusBadge({ status: 'weird' })).toEqual({ text: '未知状态', tone: 'neutral' });
    expect(statusBadge(null)).toEqual({ text: '未知状态', tone: 'neutral' });
  });
});

describe('flagBadges（标记，列表与详情共用）', () => {
  it('脏输入 / 无标记 → 空数组', () => {
    expect(flagBadges(null)).toEqual([]);
    expect(flagBadges(undefined)).toEqual([]);
    expect(flagBadges({})).toEqual([]);
  });
  it('测试单 → muted 标记', () => {
    expect(flagBadges({ is_test: true })).toEqual([{ text: '测试单', tone: 'muted' }]);
  });
});

describe('detailBadges（详情页头）', () => {
  const texts = (o: unknown): string[] => detailBadges(o).map((b) => b.text);
  it('已付款的单出"支付 + 履约"两枚', () => {
    expect(texts({ status: 'paid' })).toEqual(['已付款', '待发货']);
    expect(texts({ status: 'completed' })).toEqual(['已付款', '已完成']);
  });
  it('未付 / 退款 / 关闭的单只有支付侧一枚', () => {
    expect(texts({ status: 'pending_payment' })).toEqual(['未付款']);
    expect(texts({ status: 'refunding' })).toEqual(['退款中']);
    expect(texts({ status: 'expired' })).toEqual(['已过期']);
    expect(texts({ status: 'nope' })).toEqual(['未知状态']);
  });
  it('拒付 = danger、测试单 = muted，追加在后', () => {
    expect(detailBadges({ status: 'shipped', has_dispute: true, is_test: true })).toEqual([
      { text: '已付款', tone: 'success' },
      { text: '已发货', tone: 'info' },
      { text: '拒付中', tone: 'danger' },
      { text: '测试单', tone: 'muted' },
    ]);
  });
});
