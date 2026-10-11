/**
 * 运费表指纹（ADM-4 / AJ-458）：管理端整表保存时带上"我读到的那张表"的指纹，服务端在锁内比对——两人同时编辑不再静默覆盖。
 */
import { describe, expect, it } from 'vitest';
import { shippingRatesFingerprint } from './shipping-fingerprint.js';

const A = [
  { carrier: 'Japan Post', max_weight_g: 2000, price_jpy: 4950, active: true },
  { carrier: 'Japan Post', max_weight_g: 500, price_jpy: 2100, active: true },
];

describe('shippingRatesFingerprint', () => {
  it('与行顺序无关；任一字段变了指纹就变；空表有确定指纹', () => {
    const fp = shippingRatesFingerprint(A);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(shippingRatesFingerprint([A[1]!, A[0]!])).toBe(fp);
    expect(shippingRatesFingerprint([{ ...A[0]!, price_jpy: 4951 }, A[1]!])).not.toBe(fp);
    expect(shippingRatesFingerprint([{ ...A[0]!, active: false }, A[1]!])).not.toBe(fp);
    expect(shippingRatesFingerprint([])).toMatch(/^[0-9a-f]{8}$/);
  });
  it('active 缺省按 true（契约 default: true）', () => {
    expect(shippingRatesFingerprint([{ carrier: 'x', max_weight_g: 1, price_jpy: 1 }])).toBe(
      shippingRatesFingerprint([{ carrier: 'x', max_weight_g: 1, price_jpy: 1, active: true }]),
    );
  });
});
