/**
 * 职责：`daily-reconciliation.ts` 第七类（审核模式到期提醒）的 L0 单测。
 *
 * @why 这一类是**唯一不查库**的一类，所以也是唯一能用纯单测钉住的一类：
 *      它的判据（"还剩几天算临期"、"过期算不算"）一旦漂移，表现是"该报的那天没报"——
 *      而"没报"与"一切正常"在对账报告里长得一模一样（空对空假绿灯）。
 * @see server/src/review-window.ts（日期口径的唯一真源）
 */
import { describe, expect, it } from 'vitest';
import { REVIEW_WINDOW_WARN_DAYS } from '../review-window.js';
import { reviewWindowAnomaly } from './daily-reconciliation.js';

/** 固定的"今天"（UTC 2026-11-15）：用例写死日期，不写会随时间腐坏的相对值。 */
const TODAY = '2026-11-15';

describe('第七类：审核模式到期提醒（A7 / AJ-378）', () => {
  describe('不响的情形（count = 0）', () => {
    it('审核模式没开 → 不响（正常运营状态的绝大多数日子）', () => {
      expect(reviewWindowAnomaly({ on: false, until: undefined, todayUtc: TODAY }).count).toBe(0);
    });

    it.each([
      ['2026-12-15', '还剩 30 天'],
      [`2026-11-${15 + REVIEW_WINDOW_WARN_DAYS + 1}`, '刚超出提醒窗口一天'],
      ['2027-11-15', '还剩一年'],
    ])('截止日 %s（%s）→ 不响（审核期中间不打扰）', (until) => {
      expect(reviewWindowAnomaly({ on: true, until, todayUtc: TODAY }).count).toBe(0);
    });
  });

  describe('该响的情形（count = 1）', () => {
    it.each([
      [`2026-11-${15 + REVIEW_WINDOW_WARN_DAYS}`, '窗口最后一天'],
      ['2026-11-17', '还剩 2 天'],
      ['2026-11-16', '还剩 1 天'],
    ])('截止日 %s（%s）→ 报 review_mode_closing', (until) => {
      const c = reviewWindowAnomaly({ on: true, until, todayUtc: TODAY });
      expect(c.key).toBe('review_mode_closing');
      expect(c.count).toBe(1);
    });

    it('截止日当天 → 报 review_mode_closing（当天仍可下单，但已是最后一天）', () => {
      const c = reviewWindowAnomaly({ on: true, until: '2026-11-15', todayUtc: TODAY });
      expect(c.key).toBe('review_mode_closing');
      expect(c.count).toBe(1);
    });

    it.each([
      ['2026-11-14', '昨天'],
      ['2026-11-01', '半个月前'],
    ])('截止日 %s（已过期，%s）→ 报 review_mode_expired', (until) => {
      const c = reviewWindowAnomaly({ on: true, until, todayUtc: TODAY });
      expect(c.key).toBe('review_mode_expired');
      expect(c.count).toBe(1);
    });

    /**
     * @why 这一支在生产**不可达**（启动闸门 2d 会先拒），钉住它是为了
     *      "将来有人放宽了闸门"的那一天：那时它必须立刻报出"连截止日都没有"，
     *      而不是让整类检查静默失明（daily-reconciliation.ts @limitation 二）。
     */
    it('开着却没配截止日 → 报 review_mode_no_deadline（防御支，不许静默）', () => {
      const c = reviewWindowAnomaly({ on: true, until: undefined, todayUtc: TODAY });
      expect(c.key).toBe('review_mode_no_deadline');
      expect(c.count).toBe(1);
    });
  });

  describe('报出的内容要能直接回答"还剩几天"', () => {
    /**
     * @why 对账邮件里只有计数（`ops-alert-mail.ts` 只发 counts），所以"还剩几天"
     *      这类关键细节只能落在**日志的取样 id** 上。它若退化成空数组，
     *      运营收到"review_mode_closing=1"却不知道是哪一天到期——等于没报。
     */
    it.each([
      ['2026-11-17', '剩2天'],
      ['2026-11-14', '已过1天'],
    ])('截止日 %s 的取样里带上天数（%s）', (until, expected) => {
      const c = reviewWindowAnomaly({ on: true, until, todayUtc: TODAY });
      expect(c.ids).toHaveLength(1);
      expect(c.ids[0]).toContain(expected);
    });
  });
});
