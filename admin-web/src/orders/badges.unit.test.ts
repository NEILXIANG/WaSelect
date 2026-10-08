/**
 * 职责：订单徽章口径（AJ-400）——列表一枚、详情"支付 + 履约 + 标记"。
 * @see ./badges.ts
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import { detailBadges, flagBadges, statusBadge } from './badges.js';

describe('statusBadge（列表）', () => {
  it('十态都有色调；待发货 = warn、已发货 = info、已退款 = muted', () => {
    for (const s of ORDER_STATUS) expect(statusBadge({ status: s }).text).not.toBe('未知状态');
    expect(statusBadge({ status: 'paid' })).toEqual({ text: '待发货', tone: 'warn' });
    expect(statusBadge({ status: 'shipped' })).toEqual({ text: '已发货', tone: 'info' });
    expect(statusBadge({ status: 'refunded' })).toEqual({ text: '已退款', tone: 'muted' });
  });
  it('认不出的状态 → 未知状态（不抛）', () => {
    expect(statusBadge({ status: 'weird' })).toEqual({ text: '未知状态', tone: 'neutral' });
    expect(statusBadge(null)).toEqual({ text: '未知状态', tone: 'neutral' });
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
    expect(flagBadges(null)).toEqual([]);
  });
});
