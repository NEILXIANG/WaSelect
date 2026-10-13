/**
 * 小程序售后口径（AJ-420）：与 shared 逐项比对（镜像不能漂移）+ 订单详情卡片的出现规则。
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_SALE_DESCRIPTION_MAX as SHARED_MAX,
  AFTER_SALE_OPEN_STATUSES as SHARED_OPEN_STATUSES,
  AFTER_SALE_ORDER_STATUSES as SHARED_ORDER_STATUSES,
  AFTER_SALE_REASONS,
  AFTER_SALE_REASON_LABELS,
  AFTER_SALE_STATUS_LABELS as SHARED_STATUS_LABELS,
} from '@waselect/shared';
import {
  AFTER_SALE_DESCRIPTION_MAX,
  AFTER_SALE_OPEN_STATUSES,
  AFTER_SALE_ORDER_STATUSES,
  AFTER_SALE_REASON_ROWS,
  AFTER_SALE_STATUS_LABELS,
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
