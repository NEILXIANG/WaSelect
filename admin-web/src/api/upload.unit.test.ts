/**
 * 职责：`admin-web/src/api/upload.ts` 的单测（从 `products/api.unit.test.ts` 迁出）。
 *
 * @why 上传是商品图与 Banner 图共用的能力，它的三种失败都会表现为"图没传上去"：
 *      走错 content-type（服务端拿不到边界 → 40001）、ImageSet 三档不全（`<img src="">`）、
 *      HTTP 非 2xx 被当 JSON 解析。
 */
import { describe, expect, it } from 'vitest';
import { uploadImage } from './upload.js';

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

const deps = (fetchImpl: typeof fetch) => ({
  baseUrl: 'http://localhost:3000',
  getToken: () => 'tk',
  fetchImpl,
});

describe('uploadImage（multipart，不走 JSON 封装）', () => {
  it('走 FormData 而不是 JSON.stringify（body 是 FormData 实例）', async () => {
    const { impl, seen } = stubFetch(() =>
      json({ thumb: 't', card: 'c', detail: 'd', image_key: 'k' }, 201),
    );
    const file = new Blob(['x'], { type: 'image/png' }) as unknown as File;
    const out = await uploadImage(deps(impl), file);
    expect(seen[0]?.init.body).toBeInstanceOf(FormData);
    // ⚠️ 没有 content-type: application/json（否则服务端拿不到 multipart 边界 → 40001）
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(out).toEqual({ thumb: 't', card: 'c', detail: 'd', image_key: 'k' });
  });

  it('⚠️ image_key 缺失或空串 → 抛（0.6.8 起服务端恒返回，缺了 Banner 提交的就是空 key）', async () => {
    for (const body of [
      { thumb: 't', card: 'c', detail: 'd' },
      { thumb: 't', card: 'c', detail: 'd', image_key: '' },
    ]) {
      const { impl } = stubFetch(() => json(body, 201));
      await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
        /image_key/,
      );
    }
  });

  it('⚠️ 三档缺一/缺二 → 抛（畸形响应）；三档全缺 → 放行（IMG_BASE_URL 未配置的降级形状）', async () => {
    for (const missing of ['thumb', 'card', 'detail'] as const) {
      const body: Record<string, string> = { thumb: 't', card: 'c', detail: 'd', image_key: 'k' };
      delete body[missing];
      const { impl } = stubFetch(() => json(body, 201));
      await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
        /三档不全/,
      );
    }
    // 全缺是合法降级（banner image 同口径：字段缺席才是"没有 URL"），调用方自行决定能否接受
    const { impl } = stubFetch(() => json({ image_key: 'k' }, 201));
    const out = await uploadImage(deps(impl), new Blob(['x']) as unknown as File);
    expect(out).toEqual({ image_key: 'k' });
  });

  it('HTTP 非 2xx → 抛（不把错误页当 JSON 解析）', async () => {
    const { impl } = stubFetch(() => json({ code: 40001, message: 'bad' }, 400));
    await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
