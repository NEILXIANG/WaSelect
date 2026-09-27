/**
 * 职责：`admin-web/src/banners/api.ts` 的单测（假 fetch 注入）。
 *
 * @why 钉的是三处**形状/语义**差异：列表是裸数组、新建必须拿到 id（否则编辑会打到 /undefined）、
 *      删除是 204 空体（不能被当成网络失败）。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../api/client.js';
import { NETWORK_ERROR_CODE } from '../api/errors.js';
import { createBanner, deleteBanner, listBanners, updateBanner } from './api.js';

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

/** 204 空体（契约的 DELETE）。 */
const noContent = (): Response =>
  ({
    ok: true,
    status: 204,
    headers: new Headers({ 'content-length': '0' }),
    json: async () => null,
  }) as unknown as Response;

const api = (fetchImpl: typeof fetch) =>
  createAdminApi({ baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl });

describe('listBanners', () => {
  it('GET /admin/banners，原样返回数组', async () => {
    const { impl, seen } = stubFetch(() => json([{ id: 'b-1', sort: 10 }]));
    const res = await listBanners(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/banners');
    expect(res).toHaveLength(1);
  });

  it('⚠️ 响应是对象 → 抛（契约是裸数组）', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listBanners(api(impl))).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });
  });
});

describe('createBanner', () => {
  it('POST 并返回带 id 的 Banner', async () => {
    const { impl, seen } = stubFetch(() => json({ id: 'b-1', image_key: 'k' }, 201));
    const res = await createBanner(api(impl), { image_key: 'k' });
    expect(seen[0]?.init.method).toBe('POST');
    expect(res.id).toBe('b-1');
  });

  it('⚠️ 201 但缺 id → 抛（后面编辑会打到 /admin/banners/undefined）', async () => {
    const { impl } = stubFetch(() => json({ image_key: 'k' }, 201));
    await expect(createBanner(api(impl), { image_key: 'k' })).rejects.toThrow(/缺 id/);
  });
});

describe('updateBanner', () => {
  it('PUT 到 /admin/banners/{id}，id 被 encode', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await updateBanner(api(impl), 'b 1/x', { image_key: 'k' });
    expect(seen[0]?.url).toContain('/api/v1/admin/banners/b%201%2Fx');
    expect(seen[0]?.init.method).toBe('PUT');
  });
});

describe('deleteBanner', () => {
  it('DELETE 且 204 空体**不算失败**（当成网络失败会让运营以为没删掉、再点一次拿 40400）', async () => {
    const { impl, seen } = stubFetch(() => noContent());
    await expect(deleteBanner(api(impl), 'b-1')).resolves.toBeUndefined();
    expect(seen[0]?.init.method).toBe('DELETE');
  });
});
