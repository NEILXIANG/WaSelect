/** 地址被拒（40002）给用户看的话（AJ-498）。 */
import { describe, expect, it } from 'vitest';
import { addressRejectText } from './address-reject.js';

describe('addressRejectText', () => {
  it('🔴 邮编与州对不上 → 说邮编和州，不说"须为英文"', () => {
    expect(addressRejectText({ field: 'postal_code', reason: 'zip_state_mismatch' })).toBe(
      '邮编和州对不上：请检查州或邮编',
    );
  });
  it('只有字段 → 按字段说', () => {
    expect(addressRejectText({ field: 'recipient' })).toContain('英文或拼音');
    expect(addressRejectText({ field: 'postal_code' })).toContain('5 位数字');
  });
  it('认不出 / 形状不对 → null（调用方退回通用文案）', () => {
    expect(addressRejectText({ field: 'whatever' })).toBeNull();
    expect(addressRejectText(null)).toBeNull();
    expect(addressRejectText('x')).toBeNull();
  });
});
