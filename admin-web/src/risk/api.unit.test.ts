/**
 * 职责：`admin-web/src/risk/api.ts` 的单测（假 fetch 注入）。
 *
 * @why 钉的两条：拒付列表是**裸数组**（照抄 `{items:[]}` 会空白不报错）；
 *      拉黑**缺 id 就直接不发请求**（打到 `/admin/users//block` 会变成 404 而不是 40001，
 *      排查方向完全不同）。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../api/client.js';
import { NETWORK_ERROR_CODE } from '../api/errors.js';
import { blockUser, listDisputes } from './api.js';

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    seen.push({ url: u, init: i });
    return handler(u, i);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const json = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  }) as unknown as Response;

const api = (fetchImpl: typeof fetch) =>
  createAdminApi({ baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl });

describe('listDisputes', () => {
  it('不带 status 时不拼 query', async () => {
    const { impl, seen } = stubFetch(() => json([{ dispute_id: 'dp_1' }]));
    const res = await listDisputes(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/disputes');
    expect(res).toHaveLength(1);
  });

  it('带 status 时拼上（服务端过滤，不是前端过滤）', async () => {
    const { impl, seen } = stubFetch(() => json([]));
    await listDisputes(api(impl), 'open');
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/disputes?status=open');
  });

  it('⚠️ 响应是对象 → 抛（契约是裸数组）', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listDisputes(api(impl))).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });
  });
});

describe('blockUser', () => {
  it('POST 到 /admin/users/{id}/block，id 被 encode', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await blockUser(api(impl), { userId: 'u 1/x', reason: '测试' });
    expect(seen[0]?.url).toContain('/api/v1/admin/users/u%201%2Fx/block');
    expect(seen[0]?.init.method).toBe('POST');
  });

  it('⚠️ 空 id → 直接抛，**一个请求都不发**（打到 /admin/users//block 会变成 404）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await expect(blockUser(api(impl), { userId: '   ', reason: '测试' })).rejects.toThrow(
      /缺少用户 id/,
    );
    expect(seen).toHaveLength(0);
  });

  it('🔴 带 order_id 时**真的发进请求体**（服务端据此核对归属，ADM3-01 纵深防御）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await blockUser(api(impl), { userId: 'u-1', orderId: 'o-1', reason: ' 三次拒付 ' });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ order_id: 'o-1', reason: '三次拒付' });
  });

  it('不带 order_id → 请求体只有原因（AJ-449：原因必填，凭据可选）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await blockUser(api(impl), { userId: 'u-1', reason: '测试' });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ reason: '测试' });
  });

  it('order_id 是空串 → 当"没带"发（不送一个空串去撞 40001）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await blockUser(api(impl), { userId: 'u-1', orderId: '   ', reason: '测试' });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ reason: '测试' });
  });
});
