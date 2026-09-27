/** 职责：词表的两条不变量——每个可能写入的 result 都装得进 VARCHAR(32)；死过滤值不再出现。 */
import { describe, expect, it } from 'vitest';
import { SETTLEMENT_MISMATCH_REASONS } from './mark-paid.js';
import {
  RESULT_IGNORED_PREFIX,
  RESULT_LATE_PAYMENT,
  RESULT_MAX_LEN,
  RESULT_MISMATCH_PREFIX,
  RESULT_PAID,
  RESULT_PAID_ALREADY,
  RESULT_STATUS_CONFLICT,
  RESULT_UNMATCHED_PREFIX,
} from './webhook-results.js';

describe('webhook_events.result 词表', () => {
  it('每个管线可能写入的值都 ≤ 列宽 32（全量审计复审：mismatch:settlement_unverifiable 恰好 32，零余量要钉住）', () => {
    const outcomes = ['succeeded', 'failed', 'expired', 'refunded', 'disputed', 'unknown'];
    const all = [
      RESULT_PAID,
      RESULT_PAID_ALREADY,
      RESULT_LATE_PAYMENT,
      RESULT_STATUS_CONFLICT,
      `${RESULT_UNMATCHED_PREFIX}order_not_found`,
      ...SETTLEMENT_MISMATCH_REASONS.map((r) => `${RESULT_MISMATCH_PREFIX}${r}`),
      ...outcomes.map((o) => `${RESULT_IGNORED_PREFIX}${o}`),
    ];
    for (const v of all) expect(v.length, v).toBeLessThanOrEqual(RESULT_MAX_LEN);
  });

  it('对账 SQL 曾经精确匹配的两个死值不再是词表的一部分', () => {
    const vocab = [RESULT_PAID, RESULT_PAID_ALREADY, RESULT_LATE_PAYMENT, RESULT_STATUS_CONFLICT];
    expect(vocab).not.toContain('status_conflict');
    expect(vocab).not.toContain('needs_refund');
  });
});
