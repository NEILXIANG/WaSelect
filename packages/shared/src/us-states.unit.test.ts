/** 职责：美国州码白名单（剩余清单 4-5 / A27 / C05）。 */
import { describe, expect, it } from 'vitest';
import { US_STATES, isUsStateCode } from './us-states.js';

describe('US_STATES', () => {
  it('🔴 与 USPS Pub 28 附录 B 逐条一致：62 个（50 州 + DC + 属地 / 自由联系国 8 + 军邮 3），代码不重复', () => {
    expect(US_STATES).toHaveLength(62);
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(62);
    for (const c of [
      'CA',
      'NY',
      'DC',
      'PR',
      'GU',
      'VI',
      'AS',
      'MP',
      'FM',
      'MH',
      'PW',
      'AA',
      'AE',
      'AP',
    ]) {
      expect(isUsStateCode(c), c).toBe(true);
    }
  });

  it('非白名单 / 小写 / 非字符串 → false', () => {
    for (const c of ['XX', 'ca', 'UM', '', 'CAL', null, 42])
      expect(isUsStateCode(c), String(c)).toBe(false);
  });
});
