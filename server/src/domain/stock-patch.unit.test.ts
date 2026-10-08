/**
 * `parseStockPatch` 边界表（AJ-403：列表内联改库存）。
 * @why 两个整数各自的边界都要跨过：0 / -1、INT 上界 / 上界 + 1、小数、字符串数字、缺省。
 *      上界那一格是"本来会让库抛 22003"的值（stock-patch.ts 的 @measured）——路由层有 22 类兜底也回 40001，
 *      所以**只有这里**能区分"判成 stock_invalid"与"漏判、靠库兜底"（缺陷注入实测：去掉上界后路由用例仍绿）。
 */
import { describe, expect, it } from 'vitest';
import { PG_INT_MAX, parseStockPatch } from './stock-patch.js';

describe('parseStockPatch', () => {
  it.each([
    [
      { stock: 0, expected_stock: 0 },
      { ok: true, stock: 0, expectedStock: 0 },
    ],
    [
      { stock: 30, expected_stock: 3 },
      { ok: true, stock: 30, expectedStock: 3 },
    ],
    [
      { stock: PG_INT_MAX, expected_stock: PG_INT_MAX },
      { ok: true, stock: 2147483647, expectedStock: 2147483647 },
    ],
    [
      { stock: -1, expected_stock: 3 },
      { ok: false, reason: 'stock_invalid' },
    ],
    [
      { stock: PG_INT_MAX + 1, expected_stock: 3 },
      { ok: false, reason: 'stock_invalid' },
    ],
    [
      { stock: 1.5, expected_stock: 3 },
      { ok: false, reason: 'stock_invalid' },
    ],
    [
      { stock: '30', expected_stock: 3 },
      { ok: false, reason: 'stock_invalid' },
    ],
    [
      { stock: Number.NaN, expected_stock: 3 },
      { ok: false, reason: 'stock_invalid' },
    ],
    [{ expected_stock: 3 }, { ok: false, reason: 'stock_invalid' }],
    [{ stock: 30 }, { ok: false, reason: 'expected_stock_required' }],
    [
      { stock: 30, expected_stock: null },
      { ok: false, reason: 'expected_stock_required' },
    ],
    [
      { stock: 30, expected_stock: -1 },
      { ok: false, reason: 'expected_stock_required' },
    ],
    [
      { stock: 30, expected_stock: PG_INT_MAX + 1 },
      { ok: false, reason: 'expected_stock_required' },
    ],
    [
      { stock: 30, expected_stock: '3' },
      { ok: false, reason: 'expected_stock_required' },
    ],
    [null, { ok: false, reason: 'stock_invalid' }],
    ['stock=30', { ok: false, reason: 'stock_invalid' }],
  ])('%j → %j', (input, expected) => {
    expect(parseStockPatch(input)).toEqual(expected);
  });

  it('上界常量就是 Postgres int4 上界（与 products.stock INT 同口径）', () => {
    expect(PG_INT_MAX).toBe(2 ** 31 - 1);
  });
});
