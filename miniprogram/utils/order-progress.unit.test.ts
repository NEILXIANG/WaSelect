/**
 * 职责：订单进度条（M-12，AJ-408）的单测。
 *
 * @why 进度条错了不报错，只会**说错话**：退款单显示"送达"已点亮、取消单显示"付款"已完成，
 *      买家据此以为钱付出去了 / 货在路上。所以每个终态都要单独钉住"点亮到哪一步、分支写什么"。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from '@waselect/shared';
import { PROGRESS_STEPS, orderProgress } from './order-progress.js';

const states = (p: ReturnType<typeof orderProgress>): string[] => p.steps.map((s) => s.state);
const tl = (...ss: string[]): Array<{ status: string; at: string }> =>
  ss.map((status, i) => ({ status, at: `2026-10-0${i + 1}T00:00:00.000Z` }));

describe('PROGRESS_STEPS', () => {
  it('五步：下单 → 付款 → 日本采购 → 发货 → 送达', () => {
    expect(PROGRESS_STEPS.map((s) => s.label)).toEqual([
      '下单',
      '付款',
      '日本采购',
      '发货',
      '送达',
    ]);
  });
});

describe('orderProgress：主线', () => {
  it.each([
    ['created', ['done', 'current', 'todo', 'todo', 'todo']],
    ['pending_payment', ['done', 'current', 'todo', 'todo', 'todo']],
    ['paid', ['done', 'done', 'current', 'todo', 'todo']],
    ['shipped', ['done', 'done', 'done', 'current', 'todo']],
    ['delivered', ['done', 'done', 'done', 'done', 'current']],
    ['completed', ['done', 'done', 'done', 'done', 'done']],
  ])('%s', (status, expected) => {
    const p = orderProgress({ status, timeline: [] });
    expect(p.show).toBe(true);
    expect(states(p)).toEqual(expected);
    expect(p.branch).toBeNull();
  });
});

describe('orderProgress：终态分支（取消 / 超时 / 退款）', () => {
  it('🔴 已取消：只点亮"下单"，其后一律"未发生"，分支写"已取消"', () => {
    const p = orderProgress({ status: 'cancelled', timeline: tl('created', 'cancelled') });
    expect(states(p)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(p.branch).toEqual({ status: 'cancelled', title: '已取消' });
  });

  it('🔴 已超时关闭：同上（没有时间线也一样——状态机里只有待付款能超时）', () => {
    const p = orderProgress({ status: 'expired' });
    expect(states(p)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(p.branch).toEqual({ status: 'expired', title: '已超时关闭' });
  });

  it('🔴 付款后、发货前退款：点亮到"付款"，分支"退款中"', () => {
    const p = orderProgress({
      status: 'refunding',
      timeline: tl('created', 'pending_payment', 'paid', 'refunding'),
    });
    expect(states(p)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped']);
    expect(p.branch).toEqual({ status: 'refunding', title: '退款中' });
  });

  it('🔴 发货后退款：点亮到"发货"（采购必然已完成），分支"已退款"', () => {
    const p = orderProgress({
      status: 'refunded',
      timeline: tl('created', 'pending_payment', 'paid', 'shipped', 'refunding', 'refunded'),
    });
    expect(states(p)).toEqual(['done', 'done', 'done', 'done', 'skipped']);
    expect(p.branch).toEqual({ status: 'refunded', title: '已退款' });
  });

  it('送达后退款：五步全亮 + 分支', () => {
    const p = orderProgress({
      status: 'refunded',
      timeline: tl('created', 'paid', 'shipped', 'delivered', 'refunding', 'refunded'),
    });
    expect(states(p)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(p.branch?.title).toBe('已退款');
  });

  it('⚠️ 退款单没有时间线 → 保守点亮到"付款"（退款只能从已付款之后进入），不猜发没发货', () => {
    const p = orderProgress({ status: 'refunding', timeline: 'garbage' });
    expect(states(p)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped']);
  });
});

describe('orderProgress：兜底', () => {
  it('🔴 未知状态 / 脏输入 → 不显示进度条（不给一个可能说错话的进度）', () => {
    expect(orderProgress({ status: 'brand_new' }).show).toBe(false);
    expect(orderProgress({ status: 'brand_new' }).steps).toEqual([]);
    expect(orderProgress(null).show).toBe(false);
    expect(orderProgress('paid').show).toBe(false);
  });

  it('时间线里的脏行（非对象 / 未知状态）忽略，不影响点亮', () => {
    const p = orderProgress({
      status: 'refunded',
      timeline: [null, 7, { status: 'teleported' }, { status: 'paid' }, { status: 'refunded' }],
    });
    expect(states(p)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped']);
  });

  it('🔴 契约 10 态每一个都有确定的进度（不会走到"不显示"兜底）', () => {
    for (const s of ORDER_STATUS) {
      const p = orderProgress({ status: s, timeline: [] });
      expect([s, p.show, p.steps.length]).toEqual([s, true, 5]);
    }
  });

  it('每一步带 key（给 wx:key）与 label', () => {
    const p = orderProgress({ status: 'paid' });
    expect(p.steps.map((s) => s.key)).toEqual([
      'placed',
      'paid',
      'purchasing',
      'shipped',
      'delivered',
    ]);
    expect(p.steps[2]).toEqual({ key: 'purchasing', label: '日本采购', state: 'current' });
  });
});
