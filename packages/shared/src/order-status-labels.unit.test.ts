/**
 * 职责：订单状态中文词表（后台列表 / 详情 / 导出共用，AJ-494）。
 * @why 原在 admin-web；服务端导出订单总表也要写中文状态，词表挪到 shared 当唯一真源。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_STATUS } from './enums.js';
import { ORDER_STATUS_LABELS } from './order-status-labels.js';

describe('ORDER_STATUS_LABELS', () => {
  it('🔴 覆盖全部订单状态，且每个都是中文', () => {
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual([...ORDER_STATUS].sort());
    for (const s of ORDER_STATUS) expect(ORDER_STATUS_LABELS[s], s).toMatch(/[一-龥]/);
  });
  it('与后台原口径一致：paid → 待发货、delivered → 已签收', () => {
    expect(ORDER_STATUS_LABELS.paid).toBe('待发货');
    expect(ORDER_STATUS_LABELS.delivered).toBe('已签收');
  });
});
