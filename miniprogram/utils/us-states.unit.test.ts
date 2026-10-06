/** 职责：小程序端州码副本（剩余清单 4-5）——与 packages/shared 的 US_STATES 逐条一致（服务端按它校验）。 */
import { describe, expect, it } from 'vitest';
import { US_STATES } from '@waselect/shared';
import { STATE_LABELS, US_STATE_ROWS, stateIndexOf } from './us-states.js';

describe('us-states（小程序副本）', () => {
  it('🔴 与 shared 逐条一致（代码与顺序）：两边各写一份时，漏一个州 = 那个州的买家选不到', () => {
    expect(US_STATE_ROWS.map((r) => r.code)).toEqual(US_STATES.map((s) => s.code));
  });

  it('下拉文案 = "代码 · 英文名"；按代码找下标，找不到 → -1（下拉显示占位）', () => {
    expect(STATE_LABELS[US_STATE_ROWS.findIndex((r) => r.code === 'CA')]).toBe('CA · California');
    expect(stateIndexOf('CA')).toBe(US_STATE_ROWS.findIndex((r) => r.code === 'CA'));
    expect(stateIndexOf('ca')).toBe(US_STATE_ROWS.findIndex((r) => r.code === 'CA'));
    expect(stateIndexOf('XX')).toBe(-1);
    expect(stateIndexOf(undefined)).toBe(-1);
  });
});
