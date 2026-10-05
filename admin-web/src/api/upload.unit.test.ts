/**
 * 职责：`admin-web/src/api/upload.ts` 的单测（从 `products/api.unit.test.ts` 迁出）。
 *
 * @why 上传是商品图与 Banner 图共用的能力，它的三种失败都会表现为"图没传上去"：
 *      走错 content-type（服务端拿不到边界 → 40001）、ImageSet 三档不全（`<img src="">`）、
 *      HTTP 非 2xx 被当 JSON 解析。
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
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
      json({ thumb: 't', card: 'c', detail: 'd', image_key: 'k', image_id: 'id-1' }, 201),
    );
    const file = new Blob(['x'], { type: 'image/png' }) as unknown as File;
    const out = await uploadImage(deps(impl), file);
    expect(seen[0]?.init.body).toBeInstanceOf(FormData);
    // ⚠️ 没有 content-type: application/json（否则服务端拿不到 multipart 边界 → 40001）
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(out).toEqual({
      thumb: 't',
      card: 'c',
      detail: 'd',
      image_key: 'k',
      image_id: 'id-1',
    });
  });

  it('⚠️ image_id 缺失或空串 → 抛（0.6.28 起恒返回；缺它商品图就只能存回三档 URL）', async () => {
    // @why 与 `image_key` 不是同一条：三档 URL 可以全省略（图床域名没配），
    //      image_id **不依赖** IMG_BASE_URL——它是"要存进库的值"。
    //      静默放行的表现是"图存进去了、但存的是 URL"（AJ-361 第一步的收益被悄悄抹掉）。
    for (const body of [
      { thumb: 't', card: 'c', detail: 'd', image_key: 'k' },
      { thumb: 't', card: 'c', detail: 'd', image_key: 'k', image_id: '' },
    ]) {
      const { impl } = stubFetch(() => json(body, 201));
      await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
        /image_id/,
      );
    }
  });

  it('⚠️ image_key 缺失或空串 → 抛（0.6.8 起服务端恒返回，缺了 Banner 提交的就是空 key）', async () => {
    for (const body of [
      { thumb: 't', card: 'c', detail: 'd', image_id: 'id-1' },
      { thumb: 't', card: 'c', detail: 'd', image_key: '', image_id: 'id-1' },
    ]) {
      const { impl } = stubFetch(() => json(body, 201));
      await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
        /image_key/,
      );
    }
  });

  it('⚠️ 三档缺一/缺二 → 抛（畸形响应）；三档全缺 → 放行（IMG_BASE_URL 未配置的降级形状）', async () => {
    for (const missing of ['thumb', 'card', 'detail'] as const) {
      const body: Record<string, string> = {
        thumb: 't',
        card: 'c',
        detail: 'd',
        image_key: 'k',
        image_id: 'id-1',
      };
      delete body[missing];
      const { impl } = stubFetch(() => json(body, 201));
      await expect(uploadImage(deps(impl), new Blob(['x']) as unknown as File)).rejects.toThrow(
        /三档不全/,
      );
    }
    // 全缺是合法降级（banner image 同口径：字段缺席才是"没有 URL"），调用方自行决定能否接受。
    // ⚠️ `image_id` **不受**这条降级影响：它不依赖 IMG_BASE_URL（@limitation 四）。
    const { impl } = stubFetch(() => json({ image_key: 'k', image_id: 'id-1' }, 201));
    const out = await uploadImage(deps(impl), new Blob(['x']) as unknown as File);
    expect(out).toEqual({ image_key: 'k', image_id: 'id-1' });
  });

  it('HTTP 非 2xx 且带业务码 → 抛**业务错**（KD-13 前这里断言的是"HTTP 400"——把缺陷行为钉成了期望）', async () => {
    const { impl } = stubFetch(() => json({ code: 40001, message: 'bad' }, 400));
    const err = await uploadImage(deps(impl), new Blob(['x']) as unknown as File).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe(40001);
    expect((err as ApiError).message).toContain('bad');
  });
});

describe('uploadImage 错误收敛与 client.ts 同口径（KD-13）', () => {
  const file = () => new Blob(['x']) as unknown as File;
  const respond =
    (status: number, body: string, headers: Record<string, string> = {}): typeof fetch =>
    async () =>
      new Response(body, { status, headers });

  it('body 带业务码 → 按业务错抛：code / 服务端 message / 响应头 trace id 都带回', async () => {
    const err = await uploadImage(
      {
        baseUrl: 'https://api.test',
        getToken: () => 't',
        fetchImpl: respond(400, '{"code":40001,"message":"参数缺失或格式错误"}', {
          'x-trace-id': 'trace-from-server',
        }),
      },
      file(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(40001);
    expect((err as ApiError).message).toContain('参数缺失或格式错误');
    expect((err as ApiError).traceId).toBe('trace-from-server');
  });

  it('40101 → 先调 onUnauthorized 再抛（与 JSON 封装同序）；其它业务码不调', async () => {
    const seen: number[] = [];
    const deps = (body: string) => ({
      baseUrl: 'https://api.test',
      getToken: () => 't',
      fetchImpl: respond(401, body),
      onUnauthorized: (e: ApiError) => seen.push(e.code),
    });
    await expect(uploadImage(deps('{"code":40101,"message":"x"}'), file())).rejects.toThrow();
    expect(seen).toEqual([40101]);
    await expect(uploadImage(deps('{"code":40301,"message":"x"}'), file())).rejects.toThrow();
    expect(seen).toEqual([40101]);
  });

  it('非 JSON 错误页（平台 502 HTML）→ 仍归网络错并带 HTTP 状态', async () => {
    const err = await uploadImage(
      {
        baseUrl: 'https://api.test',
        getToken: () => 't',
        fetchImpl: respond(502, '<html>bad gateway</html>'),
      },
      file(),
    ).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(-1);
    expect((err as ApiError).message).toContain('HTTP 502');
  });
});
