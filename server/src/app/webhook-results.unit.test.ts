/** 职责：词表的两条不变量——每个可能写入的 result 都装得进 VARCHAR(32)；死过滤值不再出现。 */
import { describe, expect, it } from 'vitest';
import { SETTLEMENT_MISMATCH_REASONS } from './mark-paid.js';
import {
  RESULT_DISPUTED,
  RESULT_IGNORED_PREFIX,
  RESULT_LATE_PAYMENT,
  RESULT_MAX_LEN,
  RESULT_MISMATCH_PREFIX,
  RESULT_PAID,
  RESULT_PAID_ALREADY,
  RESULT_STATUS_CONFLICT,
  RESULT_UNMATCHED_PREFIX,
  resultValue,
} from './webhook-results.js';

describe('webhook_events.result 词表', () => {
  it('每个管线可能写入的值都 ≤ 列宽 32（全量审计复审：mismatch:settlement_unverifiable 恰好 32，零余量要钉住）', () => {
    const outcomes = ['succeeded', 'failed', 'expired', 'refunded', 'disputed', 'unknown'];
    const all = [
      RESULT_PAID,
      RESULT_PAID_ALREADY,
      RESULT_DISPUTED,
      RESULT_LATE_PAYMENT,
      RESULT_STATUS_CONFLICT,
      `${RESULT_UNMATCHED_PREFIX}order_not_found`,
      ...SETTLEMENT_MISMATCH_REASONS.map((r) => `${RESULT_MISMATCH_PREFIX}${r}`),
      ...outcomes.map((o) => `${RESULT_IGNORED_PREFIX}${o}`),
    ];
    for (const v of all) expect(v.length, v).toBeLessThanOrEqual(RESULT_MAX_LEN);
  });

  /**
   * @why 单测钉住的是"当前词表不超长"，运行时那条防线（resultValue）需要自己的用例：
   *      将来有人加了更长的 reason，第一条用例会红，但**线上已经写进去的那些**不会因为
   *      补测试而消失；真正兜住线上的是 resultValue 的截断，所以它也必须在红灯里。
   */
  it('resultValue 保证任何拼接都装得进列宽（超长截断，不让 DB 报 22001 把回调打成 500）', () => {
    expect(resultValue(RESULT_MISMATCH_PREFIX, 'channel_mismatch')).toBe(
      'mismatch:channel_mismatch',
    );
    const long = 'x'.repeat(RESULT_MAX_LEN * 2);
    const out = resultValue(RESULT_MISMATCH_PREFIX, long);
    expect(out.length).toBe(RESULT_MAX_LEN);
    expect(out.startsWith(RESULT_MISMATCH_PREFIX)).toBe(true);
    // 不抛错：抛错同样会让回调 5xx → 机构无限重发（截断的取舍见函数 @limitation）
    expect(() => resultValue(RESULT_IGNORED_PREFIX, long)).not.toThrow();
  });

  it('对账 SQL 曾经精确匹配的两个死值不再是词表的一部分', () => {
    const vocab = [RESULT_PAID, RESULT_PAID_ALREADY, RESULT_LATE_PAYMENT, RESULT_STATUS_CONFLICT];
    expect(vocab).not.toContain('status_conflict');
    expect(vocab).not.toContain('needs_refund');
  });
});
