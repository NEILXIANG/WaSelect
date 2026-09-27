/**
 * 职责：`admin-web/src/products/api.ts` 的单测（假 fetch 注入，不碰真实网络）。
 *
 * @why 钉的是"契约漂移在接口层硬失败"：
 *      ① 200 但形状不对 → 必须抛（否则 undefined 流进 UI，列表空白却不报错）；
 *      ② 列表缺 total → 分页判断不了"到底了没有"，会一直翻页；
 *      ③ 上传响应 ImageSet 三档不全 → `<img src="">` 静默空白，运营以为图没传上去；
 *      ④ 路径 / method / 幂等语义错了 → 打到了别的接口，而 UI 上只看到"没反应"。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../api/client.js';
import { NETWORK_ERROR_CODE } from '../api/errors.js';
import { listProducts, setProductStatus, updateProduct, uploadProductImage } from './api.js';

/** 造一个假 fetch：记录最后一次请求，返回预定响应。 */
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

describe('listProducts', () => {
  it('拼出 status/page/size，并原样返回 items', async () => {
    const { impl, seen } = stubFetch(() =>
      json({ items: [{ id: 'p-1', title: 'x', status: 'active' }], total: 1 }),
    );
    const res = await listProducts(api(impl), { status: 'active', page: 2, size: 20 });
    expect(seen[0]?.url).toBe(
      'http://localhost:3000/api/v1/admin/products?status=active&page=2&size=20',
    );
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
  });

  it('无参数时不带 query（不是带一堆空值）', async () => {
    const { impl, seen } = stubFetch(() => json({ items: [], total: 0 }));
    await listProducts(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/products');
  });

  it('⚠️ items 不是数组 → 抛形状错（不是静默当空列表）', async () => {
    const { impl } = stubFetch(() => json({ items: 'oops', total: 0 }));
    await expect(listProducts(api(impl))).rejects.toThrow(/形状与契约不符/);
  });

  it('⚠️ 缺 total → 抛（分页判断不了"到底了没有"，会一直翻页）', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listProducts(api(impl))).rejects.toThrow(/缺 total/);
  });

  it('⚠️ items 里有缺 id 的元素 → 抛（没 id 的行点了会打到 /admin/products/undefined）', async () => {
    const { impl } = stubFetch(() => json({ items: [{ title: 'no id' }], total: 1 }));
    await expect(listProducts(api(impl))).rejects.toThrow(/形状与契约不符/);
  });

  it('形状错误带 NETWORK_ERROR_CODE（与"业务失败"区分开）', async () => {
    const { impl } = stubFetch(() => json({ items: null, total: 0 }));
    await expect(listProducts(api(impl))).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });
  });
});

describe('updateProduct / setProductStatus', () => {
  it('PUT 走全量更新路径，id 被 encode（slug 里理论上没有特殊字符，但 id 是外部输入）', async () => {
    const { impl, seen } = stubFetch(() => json({ id: 'p-1' }));
    await updateProduct(api(impl), 'p 1/x', { title: 'x' });
    expect(seen[0]?.url).toContain('/api/v1/admin/products/p%201%2Fx');
    expect(seen[0]?.init.method).toBe('PUT');
  });

  it('⚠️ 上下架走独立 PATCH 且只发 status（不整条覆盖，防两个管理员互相覆盖）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await setProductStatus(api(impl), 'p-1', 'offline');
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/products/p-1/status');
    expect(seen[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ status: 'offline' });
  });
});

describe('uploadProductImage（multipart，不走 JSON 封装）', () => {
  it('走 FormData 而不是 JSON.stringify（body 是 FormData 实例）', async () => {
    const { impl, seen } = stubFetch(() => json({ thumb: 't', card: 'c', detail: 'd' }, 201));
    const file = new Blob(['x'], { type: 'image/png' }) as unknown as File;
    const out = await uploadProductImage(
      { baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl: impl },
      file,
    );
    expect(seen[0]?.init.body).toBeInstanceOf(FormData);
    // ⚠️ 没有 content-type: application/json（否则服务端拿不到 multipart 边界 → 40001）
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(out).toEqual({ thumb: 't', card: 'c', detail: 'd' });
  });

  it('⚠️ ImageSet 三档缺一档 → 抛（缺了前端会渲染空 src，运营以为图没传上去）', async () => {
    for (const missing of ['thumb', 'card', 'detail'] as const) {
      const body: Record<string, string> = { thumb: 't', card: 'c', detail: 'd' };
      delete body[missing];
      const { impl } = stubFetch(() => json(body, 201));
      await expect(
        uploadProductImage(
          { baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl: impl },
          new Blob(['x']) as unknown as File,
        ),
      ).rejects.toThrow(new RegExp(missing));
    }
  });

  it('HTTP 非 2xx → 抛（不把错误页当 JSON 解析）', async () => {
    const { impl } = stubFetch(() => json({ code: 40001, message: 'bad' }, 400));
    await expect(
      uploadProductImage(
        { baseUrl: 'http://localhost:3000', getToken: () => 'tk', fetchImpl: impl },
        new Blob(['x']) as unknown as File,
      ),
    ).rejects.toThrow(/HTTP 400/);
  });
});
