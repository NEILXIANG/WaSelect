/** 职责：退款原因预设与"缺货"判定的边界表（AJ-427，统一结论 5.2）。 */
import { describe, expect, it } from 'vitest';
import { REFUND_REASON_PRESETS, isOutOfStockRefundReason } from './refund-reason.js';

describe('isOutOfStockRefundReason', () => {
  it.each([
    ['缺货', true],
    ['缺货：供应商断货，预计两周', true],
    ['缺货：', true],
    ['破损', false],
    ['买家取消：客户改主意', false],
    ['其它：缺货', false], // 「其它」里写到缺货不算：预设才是运营的明确选择
    ['缺货了', false], // 不是预设格式（历史自由文本），按原行为回补
    ['缺货:半角冒号', false], // 管理端只拼全角"："
    ['', false],
  ])('%j → %s', (reason, expected) => {
    expect(isOutOfStockRefundReason(reason)).toBe(expected);
  });

  it('「缺货」确实是预设之一（判定与管理端下拉同一份词表）', () => {
    expect(REFUND_REASON_PRESETS).toContain('缺货');
  });
});
