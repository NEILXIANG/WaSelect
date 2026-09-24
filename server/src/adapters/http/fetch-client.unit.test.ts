/**
 * 职责：真实出站 HTTP 客户端的用例（`fetch` 版本）。
 *
 * @why 它只有二十行，但要钉的是**两件会变成生产事故的事**：
 *      ① **必须有超时**——`fetch` 默认不超时，上游不响应时请求会永久挂起，
 *         在支付链路上表现为"用户点了付款、一直转圈"，而且连接池被慢慢占满；
 *      ② **4xx/5xx 不当异常**——"上游说卡被拒"与"上游挂了"是两类完全不同的事，
 *         把它们都变成抛异常，调用方就只能写出同一种处理。
 *
 * @limitation 用 `vi.stubGlobal('fetch', …)` 替换全局 fetch：
 *              这里要验证的是"我们怎么调用 fetch"，不是"fetch 本身能不能联网"——
 *              真联网的测试既慢又会因为网络抖动随机红，属于典型的假失败。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchClient, DEFAULT_TIMEOUT_MS } from './fetch-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个假的 fetch，并把收到的调用记下来。 */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  return calls;
}

describe('createFetchClient', () => {
  it('透传 method / url / headers / body，并把响应收敛成 {status, body}', async () => {
    const calls = stubFetch(async () => ({ status: 201, text: async () => '{"id":"cs_1"}' }));
    const res = await createFetchClient().send({
      method: 'POST',
      url: 'https://api.stripe.test/v1/checkout/sessions',
      headers: { authorization: 'Bearer sk' },
      body: 'mode=payment',
    });
    expect(res).toEqual({ status: 201, body: '{"id":"cs_1"}' });
    expect(calls[0]?.url).toBe('https://api.stripe.test/v1/checkout/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('mode=payment');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk');
  });

  it('**必须**带超时信号（fetch 默认不超时 → 支付请求会挂死）', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: async () => '' }));
    await createFetchClient().send({ method: 'GET', url: 'https://x.test' });
    expect(calls[0]?.init.signal).toBeDefined();
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('GET 不带 body 时不传 body 字段（某些上游会拒绝空 body 的 GET）', async () => {
    const calls = stubFetch(async () => ({ status: 200, text: async () => 'ok' }));
    const res = await createFetchClient().send({ method: 'GET', url: 'https://x.test' });
    expect(res.body).toBe('ok');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.headers).toBeUndefined();
  });

  it('4xx/5xx **不抛异常**（是否失败由调用方按语义判断）', async () => {
    stubFetch(async () => ({ status: 402, text: async () => '{"error":"card_declined"}' }));
    const res = await createFetchClient().send({ method: 'POST', url: 'https://x.test' });
    expect(res.status).toBe(402);
    expect(res.body).toContain('card_declined');
  });
});
