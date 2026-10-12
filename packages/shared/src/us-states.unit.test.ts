/** 职责：美国州码白名单（剩余清单 4-5 / A27 / C05）。 */
import { describe, expect, it } from 'vitest';
import { US_STATES, ZIP_AREA_STATES, isUsStateCode, zipMatchesState } from './us-states.js';

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

// 全入口点击测试 2026-10-11：后台改址的州是自由文本，NY 手滑成 NV 照样存（面单印成 "Brooklyn, NV, 11220"）。
// 小程序早有这道核对（f1397f6），挪到 shared 给后台用；小程序副本与这里由单测比对
describe('zipMatchesState（邮编首位 ↔ 州）', () => {
  it('🔴 对不上 → false；对得上 → true', () => {
    expect(zipMatchesState('11220-7670', 'NV')).toBe(false);
    expect(zipMatchesState('11220', 'NY')).toBe(true);
    expect(zipMatchesState('98101', 'WA')).toBe(true);
  });
  it('已知例外照顾：纽约 06390、得州 885xx、华盛顿特区 569xx', () => {
    expect(zipMatchesState('06390', 'NY')).toBe(true);
    expect(zipMatchesState('88510', 'TX')).toBe(true);
    expect(zipMatchesState('56901', 'DC')).toBe(true);
  });
  it('邮编或州形状不对 → true（交给各自的格式校验去报）', () => {
    expect(zipMatchesState('abc', 'NV')).toBe(true);
    expect(zipMatchesState('11220', 'XX')).toBe(true);
  });
  it('十个首位数字都有表', () => {
    expect(ZIP_AREA_STATES).toHaveLength(10);
  });
});
