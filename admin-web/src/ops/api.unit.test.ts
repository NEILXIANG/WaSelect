/**
 * 职责：`admin-web/src/ops/api.ts` 的单测（假 fetch 注入）。
 *
 * @why 钉的是两处**形状不同**的坑：这两个 GET 返回的是**裸数组**
 *      （不是 `{items,total}`），照抄列表接口的写法会把数组当成对象，
 *      表现为"运费表空白但没报错"；以及 PUT 整表替换要发的是**数组本身**不是包装对象。
 */
import { describe, expect, it } from 'vitest';
import { createAdminApi } from '../api/client.js';
import { NETWORK_ERROR_CODE } from '../api/errors.js';
import { listFx, listShippingRates, replaceShippingRates, setFx } from './api.js';

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

describe('listFx', () => {
  it('GET /admin/fx，原样返回数组', async () => {
    const { impl, seen } = stubFetch(() => json([{ quote: 'USD', rate: 0.0066 }]));
    const res = await listFx(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/fx');
    expect(res).toHaveLength(1);
  });

  it('⚠️ 响应是对象而不是数组 → 抛（契约是裸数组）', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listFx(api(impl))).rejects.toThrow(/应为数组/);
  });

  it('形状错带 NETWORK_ERROR_CODE', async () => {
    const { impl } = stubFetch(() => json(null));
    await expect(listFx(api(impl))).rejects.toMatchObject({ code: NETWORK_ERROR_CODE });
  });
});

describe('setFx', () => {
  it('POST 到 /admin/fx，body 原样', async () => {
    const { impl, seen } = stubFetch(() => json({}, 201));
    await setFx(api(impl), { quote: 'USD', raw_rate: 0.0067 });
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/fx');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ quote: 'USD', raw_rate: 0.0067 });
  });
});

describe('listShippingRates', () => {
  it('GET /admin/shipping-rates，原样返回数组', async () => {
    const { impl, seen } = stubFetch(() =>
      json([{ carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true }]),
    );
    const res = await listShippingRates(api(impl));
    expect(seen[0]?.url).toBe('http://localhost:3000/api/v1/admin/shipping-rates');
    expect(res[0]?.price_jpy).toBe(4050);
  });

  it('⚠️ 非数组 → 抛', async () => {
    const { impl } = stubFetch(() => json({ items: [] }));
    await expect(listShippingRates(api(impl))).rejects.toThrow(/应为数组/);
  });
});

describe('replaceShippingRates（整表替换）', () => {
  it('⚠️ PUT 的 body 是**数组本身**，不是 {items:[…]} 包装', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    const rows = [{ carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4050, active: true }];
    await replaceShippingRates(api(impl), rows);
    expect(seen[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(rows);
  });

  it('空表也照发（服务端按"清空"处理；页面层已拦空表，这里是接口层不替业务判断）', async () => {
    const { impl, seen } = stubFetch(() => json({}, 200));
    await replaceShippingRates(api(impl), []);
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual([]);
  });
});
