/**
 * 职责：`fitsShippingTable` 边界表（P2-30）。
 * @why 边界必须跨过去：恰好等于最高档放行（D-46 向上取档 `>=`），多 1g 拒；包材计入。
 */
import { describe, expect, it } from 'vitest';
import { fitsShippingTable } from './shipping-fit.js';

describe('fitsShippingTable', () => {
  it.each([
    // [商品重, 包材, 最高档, 期望]
    [9750, 250, 10000, true], // 恰好装满
    [9751, 250, 10000, false], // 多 1g
    [10000, 0, 10000, true], // 包材为 0 时等于上限
    [10000, 250, 10000, false], // 单件本身等于上限、加包材就超
    [29750, 250, 30000, true], // 结构上限那一档
    [20000, 250, null, true], // 没有生效档：不判
  ] as const)('w=%i + p=%i vs max=%s → %s', (w, p, max, want) => {
    expect(fitsShippingTable(w, p, max)).toBe(want);
  });
});
