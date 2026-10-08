/**
 * 职责：客户接口层（AJ-404）——请求路径与形状校验。
 *
 * @why 形状不符按网络层异常抛（NETWORK_ERROR_CODE），不回落成空列表：
 *      "契约变了"在页面上显示成"没有客户"，运营会以为数据丢了（与 dashboard/api.ts @limitation 一同口径）。
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import { getCustomer, listCustomers } from './api.js';

function fakeApi(body: unknown) {
  const calls: Array<{ path: string; method?: string }> = [];
  const api = (async (req: { path: string; method?: string }) => {
    calls.push(req);
    return body;
  }) as never;
  return { api, calls };
}

describe('listCustomers', () => {
  it('带关键字与页码打 GET /admin/customers；回原样 items / total', async () => {
    const { api, calls } = fakeApi({ items: [{ id: 'u-1' }], total: 1 });
    const r = await listCustomers(api, { keyword: 'zhang', page: 2 });
    expect(calls[0]?.path).toBe('/api/v1/admin/customers?keyword=zhang&page=2');
    expect(r).toEqual({ items: [{ id: 'u-1' }], total: 1 });
  });

  it('形状不符（缺 total / items 不是数组）→ 抛 NETWORK_ERROR_CODE，不当成"没有客户"', async () => {
    for (const body of [{ items: [] }, { items: {}, total: 0 }, null]) {
      const { api } = fakeApi(body);
      const e = await listCustomers(api, { keyword: '', page: 1 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe(NETWORK_ERROR_CODE);
    }
  });
});

describe('getCustomer', () => {
  const OK = {
    id: 'u-1',
    created_at: '2026-08-20T03:00:00.000Z',
    blocked: false,
    stats: { order_count: 0, paid_order_count: 0, paid_total_jpy: 0, test_order_count: 0 },
    addresses: [],
    orders: [],
    risk: { dispute_count: 0, open_dispute_count: 0 },
  };

  it('id 编码进路径（id 里可能有 / 等字符）', async () => {
    const { api, calls } = fakeApi(OK);
    await getCustomer(api, 'u-1/x');
    expect(calls[0]?.path).toBe('/api/v1/admin/customers/u-1%2Fx');
  });

  it('缺 stats / risk / addresses / orders 任一 → 抛', async () => {
    for (const k of ['stats', 'risk', 'addresses', 'orders', 'id']) {
      const body: Record<string, unknown> = { ...OK };
      delete body[k];
      const { api } = fakeApi(body);
      await expect(getCustomer(api, 'u-1')).rejects.toBeInstanceOf(ApiError);
    }
  });
});
