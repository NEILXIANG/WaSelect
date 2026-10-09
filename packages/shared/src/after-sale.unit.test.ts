/**
 * 职责：售后申请的共享口径（AJ-420）——原因 / 状态枚举、中文文案、状态流转规则。
 */
import { describe, expect, it } from 'vitest';
import {
  AFTER_SALE_DESCRIPTION_MAX,
  AFTER_SALE_OPEN_STATUSES,
  AFTER_SALE_ORDER_STATUSES,
  AFTER_SALE_REASONS,
  AFTER_SALE_REASON_LABELS,
  AFTER_SALE_STATUSES,
  AFTER_SALE_STATUS_LABELS,
  afterSaleTransitionAllowed,
} from './after-sale.js';

describe('售后口径', () => {
  it('🔴 每个原因 / 状态都有中文文案（不把英文键漏给买家或运营）', () => {
    for (const r of AFTER_SALE_REASONS) expect(AFTER_SALE_REASON_LABELS[r], r).toMatch(/[一-龥]/);
    for (const s of AFTER_SALE_STATUSES) expect(AFTER_SALE_STATUS_LABELS[s], s).toMatch(/[一-龥]/);
    expect(AFTER_SALE_DESCRIPTION_MAX).toBe(500);
  });

  it('🔴 流转：open → processing / resolved / rejected；processing → resolved / rejected；结案后不能再改；不能退回 open', () => {
    expect(afterSaleTransitionAllowed('open', 'processing')).toBe(true);
    expect(afterSaleTransitionAllowed('open', 'resolved')).toBe(true);
    expect(afterSaleTransitionAllowed('open', 'rejected')).toBe(true);
    expect(afterSaleTransitionAllowed('processing', 'resolved')).toBe(true);
    expect(afterSaleTransitionAllowed('processing', 'rejected')).toBe(true);
    expect(afterSaleTransitionAllowed('processing', 'processing')).toBe(false);
    expect(afterSaleTransitionAllowed('resolved', 'rejected')).toBe(false);
    expect(afterSaleTransitionAllowed('rejected', 'processing')).toBe(false);
    expect(afterSaleTransitionAllowed('processing', 'open')).toBe(false);
  });

  it('"进行中"= open / processing（同一订单同时只能有一条）；可申请的订单状态 = 已发货 / 已签收 / 已完成', () => {
    expect([...AFTER_SALE_OPEN_STATUSES]).toEqual(['open', 'processing']);
    expect([...AFTER_SALE_ORDER_STATUSES]).toEqual(['shipped', 'delivered', 'completed']);
  });
});
