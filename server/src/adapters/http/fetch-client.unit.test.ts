/**
 * 职责：真实出站 HTTP 客户端的用例（`fetch` 版本）。
 *
 * @why 它只有几十行，但要钉的是**三件会变成生产事故的事**：
 *      ① **必须有超时**——`fetch` 默认不超时，上游不响应时请求会永久挂起，
 *         在支付链路上表现为"用户点了付款、一直转圈"，而且连接池被慢慢占满；
 *      ② **4xx/5xx 不当异常**——"上游说卡被拒"与"上游挂了"是两类完全不同的事，
 *         把它们都变成抛异常，调用方就只能写出同一种处理；
 *      ③ **重试必须受两道闸**：幂等键（防重复扣款）与总预算（防 30 秒挂死）。
 *
 * @limitation 用 `vi.stubGlobal('fetch', …)` 替换全局 fetch：
 *              这里要验证的是"我们怎么调用 fetch"，不是"fetch 本身能不能联网"——
 *              真联网的测试既慢又会因为网络抖动随机红，属于典型的假失败。
 * @limitation 时钟、睡眠、抖动**全部注入**：重试的边界（"预算还剩多少"）只在
 *              能精确编排时间的前提下才可测；用真实 `Date.now()` 只能写出"大概重试了"的断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchClient, DEFAULT_TIMEOUT_MS, DEFAULT_TOTAL_BUDGET_MS } from './fetch-client.js';
import {
  DEFAULT_RETRY_POLICY,
  type HttpRequest,
  type RetryPolicy,
} from '../../ports/http-client.js';
import { createLogger } from '../../logger.js';
import { MemorySink } from '../../../../test/helpers/memory-sink.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 装一个假的 fetch，并把收到的调用记下来。 */
function stubFetch(impl: (url: string, init: RequestInit, n: number) => Promise<unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  });
  return calls;
}

/** 不抖的策略（延迟可精确断言）。 */
const P: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 };

interface Harness {
  client: ReturnType<typeof createFetchClient>;
  calls: Array<{ url: string; init: RequestInit }>;
  sleeps: number[];
  sink: MemorySink;
}

/**
 * 一个可控的客户端：假 fetch + 假时钟 + 假睡眠。
 *
 * @param tickMs 每次 fetch 消耗多少毫秒（模拟真实耗时，用来触发预算用尽）
 */
function harness(opts: {
  fetch: (n: number) => Promise<{ status: number; body?: string } | never>;
  policy?: RetryPolicy;
  budgetMs?: number;
  tickMs?: number;
}): Harness {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  let clock = 0;
  const calls = stubFetch(async (_url, _init, n) => {
    clock += opts.tickMs ?? 0;
    const r = await opts.fetch(n);
    const body = r.body ?? '';
    return { status: r.status, text: async () => body };
  });
  const sleeps: number[] = [];
  const client = createFetchClient({
    retry: opts.policy ?? P,
    totalBudgetMs: opts.budgetMs ?? DEFAULT_TOTAL_BUDGET_MS,
    rand: () => 0,
    now: () => clock,
    // ⚠️ 睡眠也要消耗时钟：否则"预算"永远用不完，预算那条分支永远走不到
    sleep: async (ms) => {
      clock += ms;
      sleeps.push(ms);
    },
    logger,
  });
  return { client, calls, sleeps, sink };
}

const POST_WITH_KEY: HttpRequest = {
  method: 'POST',
  url: 'https://api.stripe.test/v1/checkout/sessions?foo=1',
  headers: { 'idempotency-key': 'k-1', authorization: 'Bearer sk_live_secret' },
  body: 'mode=payment',
};

const POST_NO_KEY: HttpRequest = {
  method: 'POST',
  url: 'https://api.stripe.test/v1/checkout/sessions',
  headers: { authorization: 'Bearer sk_live_secret' },
  body: 'mode=payment',
};

function timeoutError(): Error {
  return Object.assign(new Error('timed out'), { name: 'TimeoutError' });
}

describe('createFetchClient：基本转发', () => {
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

describe('createFetchClient：重试（受幂等键与预算两道闸）', () => {
  it('5xx + 有幂等键 → 真的重发，成功后返回 200', async () => {
    const h = harness({
      fetch: async (n) => (n === 1 ? { status: 503 } : { status: 200, body: '{"id":"cs_1"}' }),
    });
    const res = await h.client.send(POST_WITH_KEY);
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    // 退避按策略：第 1 次失败后等 base=200ms
    expect(h.sleeps).toEqual([200]);
  });

  it('🔒 5xx + **无幂等键** → 一次都不重试（重试 = 重复扣款）', async () => {
    const h = harness({ fetch: async () => ({ status: 503 }) });
    const res = await h.client.send(POST_NO_KEY);
    expect(res.status).toBe(503);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
  });

  it('超时异常 + 有幂等键 → 重试；次数用尽后**抛最后一次异常**', async () => {
    const h = harness({
      fetch: async () => {
        throw timeoutError();
      },
    });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(h.calls).toHaveLength(P.maxAttempts);
    expect(h.sleeps).toEqual([200, 400]);
  });

  it('⏱ 预算用尽 → 不再发起新尝试（10s × 3 = 30s 的挂死就是这么来的）', async () => {
    /**
     * @why 这条钉的是 `DEFAULT_TOTAL_BUDGET_MS` 存在的理由：
     *      默认单次超时 10s、最多 3 次尝试，最坏 30s——而出站调用在**用户正在等**的同步链路。
     *      预算把"总共能花多久"单独封顶，与"每次最多等多久"是两件事。
     */
    const h = harness({
      fetch: async () => ({ status: 503 }),
      budgetMs: 1_000,
      tickMs: 900,
    });
    const res = await h.client.send(POST_WITH_KEY);
    // 第一次用掉 900ms + 退避 200ms = 1100ms > 1000ms 预算 → 没有第二次
    expect(h.calls).toHaveLength(1);
    // 预算用尽且最后一次**拿到了响应** → 交出那个响应（它是上游的真实答复）
    expect(res.status).toBe(503);
    expect(h.sink.find('http_outbound').some((r) => r.result === 'budget_exhausted')).toBe(true);
  });

  it('默认的等待实现（未注入 `sleep` 时）走真实定时器', async () => {
    // @why 这条覆盖的是**装配默认值**：生产不注入 sleep，退避必须真的等。
    //      用 1ms 的延迟，既验证了它被调用，也不会拖慢测试。
    const calls = stubFetch(async (_u, _i, n) =>
      n === 1 ? { status: 503, text: async () => '' } : { status: 200, text: async () => 'ok' },
    );
    const client = createFetchClient({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    });
    await expect(client.send(POST_WITH_KEY)).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
  });

  it('预算用尽且最后一次是**异常** → 抛它（不吞、也不编造一个响应）', async () => {
    const h = harness({
      fetch: async () => {
        throw timeoutError();
      },
      budgetMs: 1_000,
      tickMs: 900,
    });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(h.calls).toHaveLength(1);
    const row = h.sink.find('http_outbound').find((r) => r.result === 'budget_exhausted');
    expect(row?.err).toBeDefined();
  });

  it('预算在**第一次就**用尽 → 一次都不发，直接抛（没有"上一次的响应"可交）', async () => {
    const h = harness({ fetch: async () => ({ status: 500 }), budgetMs: 0 });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toThrow(/预算用尽/);
    // ⚠️ 关键：不是"发一次但立刻超时"——那会白跑一趟网络，还把超时噪声混进日志
    expect(h.calls).toHaveLength(0);
  });
});

describe('createFetchClient：计时日志（脱敏）', () => {
  it('记 result / duration_ms / attempt，且**不带**查询串与鉴权头', async () => {
    const h = harness({ fetch: async () => ({ status: 200, body: 'ok' }) });
    await h.client.send(POST_WITH_KEY);
    const row = h.sink.find('http_outbound')[0];
    expect(row?.result).toBe('ok');
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
    const raw = h.sink.lines.join('\n');
    // 查询串里可能有 token / 签名 → 只记到 '?' 之前
    expect(raw).not.toContain('foo=1');
    // 鉴权头绝不能进日志
    expect(raw).not.toContain('sk_live_secret');
  });

  it('每次重试都留一条 `http_outbound_retry`（线上"上游抖了多久"要能回答）', async () => {
    const h = harness({
      fetch: async (n) => (n === 1 ? { status: 500 } : { status: 200 }),
    });
    await h.client.send(POST_WITH_KEY);
    const retries = h.sink.find('http_outbound_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.ctx).toMatchObject({ status: 500, attempt: 1, delay_ms: 200 });
  });

  it('4xx 与 5xx 的 result **分开记**（"我们的请求错了"和"上游挂了"不是一回事）', async () => {
    const h = harness({ fetch: async () => ({ status: 402, body: '{"error":"card_declined"}' }) });
    const res = await h.client.send(POST_WITH_KEY);
    expect(res.status).toBe(402);
    expect(h.sink.find('http_outbound')[0]?.result).toBe('client_error');
  });

  it('不重试的失败也会记下**为什么不重试**（否则线上只能看到"没重试"）', async () => {
    const h = harness({ fetch: async () => ({ status: 503 }) });
    await h.client.send(POST_NO_KEY);
    const row = h.sink.find('http_outbound')[0];
    expect(row?.result).toBe('server_error');
    expect(row?.ctx).toMatchObject({ no_retry_reason: expect.stringContaining('幂等键') });
  });
});
