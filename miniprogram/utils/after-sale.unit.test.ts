/**
 * 小程序售后口径（AJ-420）：与 shared 逐项比对（镜像不能漂移）+ 订单详情卡片的出现规则。
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_SALE_DESCRIPTION_MAX as SHARED_MAX,
  AFTER_SALE_DAYS_AFTER_COMPLETE as SHARED_DAYS,
  AFTER_SALE_OPEN_STATUSES as SHARED_OPEN_STATUSES,
  AFTER_SALE_ORDER_STATUSES as SHARED_ORDER_STATUSES,
  AFTER_SALE_REASONS,
  AFTER_SALE_REASON_LABELS,
  AFTER_SALE_STATUS_LABELS as SHARED_STATUS_LABELS,
} from '@waselect/shared';
import {
  AFTER_SALE_DAYS_AFTER_COMPLETE,
  AFTER_SALE_DESCRIPTION_MAX,
  AFTER_SALE_OPEN_STATUSES,
  AFTER_SALE_ORDER_STATUSES,
  AFTER_SALE_REASON_ROWS,
  AFTER_SALE_STATUS_LABELS,
  AFTER_SALE_WINDOW_CLOSED_NOTE,
  afterSaleCard,
} from './after-sale.js';

describe('与 shared 同口径（镜像）', () => {
  it('🔴 原因（值与顺序）、原因文案、状态文案、可申请状态、上限全部一致', () => {
    expect(AFTER_SALE_REASON_ROWS.map((r) => r.value)).toEqual([...AFTER_SALE_REASONS]);
    expect(Object.fromEntries(AFTER_SALE_REASON_ROWS.map((r) => [r.value, r.label]))).toEqual(
      AFTER_SALE_REASON_LABELS,
    );
    expect(AFTER_SALE_STATUS_LABELS).toEqual(SHARED_STATUS_LABELS);
    expect(AFTER_SALE_ORDER_STATUSES).toEqual([...SHARED_ORDER_STATUSES]);
    expect(AFTER_SALE_DESCRIPTION_MAX).toBe(SHARED_MAX);
    // BUG-001：服务端拿这个天数拒超期申请，前端拿它关入口——不是一个数就是"能进、提交必被拒"
    expect(AFTER_SALE_DAYS_AFTER_COMPLETE).toBe(SHARED_DAYS);
  });

  /**
   * 规律排查（本轮）：`进行中的售后 = ['open','processing']` 这条规则原先是个没名没注释的局部量 `OPEN`，
   * 于是上一组"逐项比对"漏了它（名字对不上就没人想到要比）。服务端用同一个集合判
   * "还能不能申请 / 能不能撤销发货"，漂移的表现是"页面给申请入口，提交却 40902"。
   */
  it('🔴 进行中的售后（open / processing）与 shared 一致', () => {
    expect(AFTER_SALE_OPEN_STATUSES).toEqual([...SHARED_OPEN_STATUSES]);
  });
});

const req = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'as-1',
  reason: 'damaged',
  description: '外箱压扁，罐子凹了',
  status,
  created_at: '2026-10-08T03:00:00.000Z',
  updated_at: '2026-10-08T03:00:00.000Z',
  ...extra,
});

describe('afterSaleCard', () => {
  it('🔴 已签收、没有申请 → 出卡片、给入口；待发货 / 已取消 → 整块不出', () => {
    expect(afterSaleCard({ status: 'delivered' })).toEqual({
      show: true,
      canApply: true,
      windowNote: '',
      current: null,
    });
    for (const s of ['paid', 'cancelled', 'refunded', 'pending_payment']) {
      expect(afterSaleCard({ status: s }).show).toBe(false);
    }
  });

  it('🔴 有进行中的申请 → 显示进度、不给入口；结案后 → 显示结果 + 处理说明、可再申请', () => {
    const open = afterSaleCard({ status: 'delivered', after_sale: req('processing') });
    expect(open.canApply).toBe(false);
    expect(open.current).toMatchObject({
      reasonText: '商品破损',
      statusText: '处理中',
      open: true,
    });
    expect(open.current?.atText).toContain('日本时间');

    const done = afterSaleCard({
      status: 'completed',
      after_sale: req('rejected', { resolution_note: '照片显示外箱完好' }),
    });
    expect(done).toMatchObject({ show: true, canApply: true });
    expect(done.current).toMatchObject({
      statusText: '未通过',
      note: '照片显示外箱完好',
      open: false,
    });
  });

  it('订单已退款但有历史申请：照样显示结果，不给入口；脏数据不崩', () => {
    expect(afterSaleCard({ status: 'refunded', after_sale: req('resolved') })).toMatchObject({
      show: true,
      canApply: false,
    });
    for (const bad of ['weird', 'constructor', 'toString']) {
      expect(afterSaleCard({ status: 'delivered', after_sale: req(bad) }).current).toBeNull();
    }
    expect(afterSaleCard(null).show).toBe(false);
  });
});

/**
 * 已完成后 7 天的售后窗口（BUG-001，2026-10-15）。
 * @why 服务端 0.6.96 起拒超期申请，前端原先没有这一档判据：用户看得见入口、填得完表单，
 *      提交才被 40902 `after_sale_window_closed` 打回——白填一轮且不知道为什么。
 */
describe('afterSaleCard · 完成后的 7 天窗口', () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  it('🔴 完成 8 天 → 不给入口，但卡片仍出并写明原因；完成 6 天 → 照常给入口', () => {
    const closed = afterSaleCard({ status: 'completed', completed_at: daysAgo(8) }, now);
    expect(closed.canApply).toBe(false);
    // 不能只是把按钮变灰：用户得知道"为什么没有入口"
    expect(closed.show).toBe(true);
    expect(closed.windowNote).toBe(AFTER_SALE_WINDOW_CLOSED_NOTE);
    expect(closed.windowNote).toContain(`完成后 ${AFTER_SALE_DAYS_AFTER_COMPLETE} 天内`);

    const open = afterSaleCard({ status: 'completed', completed_at: daysAgo(6) }, now);
    expect(open).toMatchObject({ show: true, canApply: true, windowNote: '' });
  });

  it('🔴 完成时刻 / 当前时刻任一拿不到 → 不拦（与服务端"没有时间依据就不拦"同口径）', () => {
    // completed_at 缺失（老数据）：静默关入口比"填完被拒"更坏——用户连原因都看不到
    expect(afterSaleCard({ status: 'completed' }, now).canApply).toBe(true);
    expect(afterSaleCard({ status: 'completed', completed_at: '不是时间' }, now).canApply).toBe(
      true,
    );
    // 调用方没给 nowMs（vm 不读时钟）：同样不判
    expect(afterSaleCard({ status: 'completed', completed_at: daysAgo(8) }).canApply).toBe(true);
  });

  it('🔴 未完成的单不吃这条限制；刚好满 7 天仍在窗口内（与服务端同一条 > 判据）', () => {
    expect(afterSaleCard({ status: 'delivered', completed_at: daysAgo(30) }, now).canApply).toBe(
      true,
    );
    expect(afterSaleCard({ status: 'completed', completed_at: daysAgo(7) }, now).canApply).toBe(
      true,
    );
  });

  it('🔴 超期且有已结案的历史申请：进度照显示，但不能再申请（服务端同样拒）', () => {
    const card = afterSaleCard(
      { status: 'completed', completed_at: daysAgo(8), after_sale: req('rejected') },
      now,
    );
    expect(card).toMatchObject({ show: true, canApply: false });
    expect(card.current).toMatchObject({ statusText: '未通过' });
    expect(card.windowNote).toBe(AFTER_SALE_WINDOW_CLOSED_NOTE);
  });
});
