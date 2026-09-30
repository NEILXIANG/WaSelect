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
import {
  createFetchClient,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  type FetchClientOptions,
} from './fetch-client.js';
import {
  DEFAULT_RETRY_POLICY,
  type HttpRequest,
  type RetryPolicy,
} from '../../ports/http-client.js';
import { DEFAULT_BREAKER_POLICY, type BreakerPolicy } from '../../ports/circuit-breaker.js';
import { CircuitOpenError, createCircuitBreaker } from './circuit-breaker.js';
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
    const r = (await impl(url, init, calls.length)) as {
      status: number;
      text: () => Promise<string>;
      headers?: Map<string, string>;
    };
    // ⚠️ 替身必须补 headers（B4 / AJ-200 之后实现会读它）：
    //    真 fetch 一定有 Headers 对象，而下面几十条用例写的是"只给 status/body"的极简形状。
    //    在各用例里逐个补会让"我要验的东西"被样板淹没，所以收口在这一处。
    return { ...r, headers: r.headers ?? new Map<string, string>() };
  });
  return calls;
}

/** 造一个空响应头袋（需要"上游建议重试"的用例用得着）。 */
function headersOf(pairs: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(pairs));
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
  fetch: (
    n: number,
  ) => Promise<{ status: number; body?: string; headers?: Map<string, string> } | never>;
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
    return { status: r.status, text: async () => body, headers: r.headers };
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
    // ⚠️ B4 / AJ-200 起响应自带 headers（键一律小写），"上游建议重试"要靠它读
    expect(res).toEqual({ status: 201, body: '{"id":"cs_1"}', headers: {} });
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
  /**
   * B4 / AJ-200：这条**反过来**了。
   * @why 旧断言钉的是"5xx + 幂等键 → 重发两次"，而它在真 Stripe 上是白等：
   *      失败结果按幂等键缓存（B3 / AJ-199），重发拿回的是同一个 503，
   *      还要白白吃掉 `totalBudgetMs` 里的一段——用户多等 200ms，什么也没换到。
   */
  it('🔒 5xx + 有幂等键但**没声明建议头** → 一次都不重试（重发拿回的是缓存的同一次失败）', async () => {
    const h = harness({
      fetch: async (n) => (n === 1 ? { status: 503 } : { status: 200, body: '{"id":"cs_1"}' }),
    });
    const res = await h.client.send(POST_WITH_KEY);
    expect(res.status).toBe(503);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
  });

  it('🔒 5xx + 声明了建议头且上游说 true → 才重发，成功后返回 200', async () => {
    const h = harness({
      fetch: async (n) =>
        n === 1
          ? { status: 503, headers: headersOf({ 'stripe-should-retry': 'true' }) }
          : { status: 200, body: '{"id":"cs_1"}' },
    });
    const res = await h.client.send({
      ...POST_WITH_KEY,
      retryAdviceHeader: 'stripe-should-retry',
    });
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    // 退避按策略：第 1 次失败后等 base=200ms
    expect(h.sleeps).toEqual([200]);
  });

  it('🔒 5xx + 声明了建议头但上游说 false → 不重发', async () => {
    const h = harness({
      fetch: async (n) =>
        n === 1
          ? { status: 503, headers: headersOf({ 'stripe-should-retry': 'false' }) }
          : { status: 200, body: '{"id":"cs_1"}' },
    });
    const res = await h.client.send({
      ...POST_WITH_KEY,
      retryAdviceHeader: 'stripe-should-retry',
    });
    expect(res.status).toBe(503);
    expect(h.calls).toHaveLength(1);
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
    // ⚠️ 用**超时**而不是 503 来吃预算：B4 / AJ-200 之后 503 一次都不重试，
    //    根本走不到"预算被退避吃光"这条路径（这正是"不再白等"的题中之意）。
    const h = harness({
      fetch: async () => {
        throw timeoutError();
      },
      budgetMs: 1_000,
      tickMs: 900,
    });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    // 第一次用掉 900ms + 退避 200ms = 1100ms > 1000ms 预算 → 没有第二次
    expect(h.calls).toHaveLength(1);
    expect(h.sink.find('http_outbound').some((r) => r.result === 'budget_exhausted')).toBe(true);
  });

  it('默认的等待实现（未注入 `sleep` 时）走真实定时器', async () => {
    // @why 这条覆盖的是**装配默认值**：生产不注入 sleep，退避必须真的等。
    //      用 1ms 的延迟，既验证了它被调用，也不会拖慢测试。
    // ⚠️ 用超时而不是 503：B4 / AJ-200 之后 503 不再重试，走不到这条路径
    const calls = stubFetch(async (_u, _i, n) => {
      if (n === 1) throw timeoutError();
      return { status: 200, text: async () => 'ok' };
    });
    const client = createFetchClient({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    });
    await expect(client.send(POST_WITH_KEY)).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
  });

  /**
   * ⚠️ 用 429 而不是 503：B4 / AJ-200 之后 503 一次都不重试，"预算被退避吃光"这条路径
   *    走不到了，而 429（上游明说"你慢点"）仍照旧重试——它才是现在唯一能用**响应**
   *    把预算吃光的失败类型。
   */
  it('预算用尽且最后一次是**响应** → 交出那个响应（它是上游的真实答复）', async () => {
    const h = harness({
      fetch: async () => ({ status: 429 }),
      budgetMs: 1_000,
      tickMs: 900,
    });
    const res = await h.client.send(POST_WITH_KEY);
    expect(h.calls).toHaveLength(1);
    expect(res.status).toBe(429);
    expect(h.sink.find('http_outbound').some((r) => r.result === 'budget_exhausted')).toBe(true);
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
    // ⚠️ 用 500 + `Stripe-Should-Retry: true`：B4 / AJ-200 之后这是**唯一**还会重试的 5xx
    const h = harness({
      fetch: async (n) =>
        n === 1
          ? { status: 500, headers: headersOf({ 'stripe-should-retry': 'true' }) }
          : { status: 200 },
    });
    await h.client.send({ ...POST_WITH_KEY, retryAdviceHeader: 'stripe-should-retry' });
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

/** 熔断策略常量（默认 5 / 30s / 1 个探测）。 */
const BP: BreakerPolicy = DEFAULT_BREAKER_POLICY;

/** 与 `POST_NO_KEY` 同形但**另一个主机**，用来验隔离。 */
const POST_NO_KEY_OTHER_HOST: HttpRequest = {
  ...POST_NO_KEY,
  url: 'https://api.wechat.test/v3/pay/transactions',
};

/**
 * 熔断接线用的可控客户端。
 *
 * @why 与上面的 `harness()` 分开写：那边钉的是**单次请求**（超时/重试/预算），
 *      这边要的是**跨多次 send** 的状态累积，而且需要"中途换上游行为"
 *      （先失败、后成功）与"把时钟推过冷却期"两个额外能力。
 */
function breakerHarness(
  over: {
    fetch?: (n: number) => Promise<{ status: number; body?: string }>;
    breaker?: FetchClientOptions['breaker'];
  } = {},
) {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  let clock = 0;
  let impl: (n: number) => Promise<{ status: number; body?: string }> =
    over.fetch ?? (async () => ({ status: 503 }));
  let count = 0;
  vi.stubGlobal('fetch', async () => {
    count += 1;
    const r = await impl(count);
    return { status: r.status, text: async () => r.body ?? '', headers: new Map<string, string>() };
  });
  const client = createFetchClient({
    retry: P,
    rand: () => 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    logger,
    // ⚠️ 显式展开三种情况：`undefined`（默认造一个）/ 注入 / `null`（关闭）。
    //    直接写 `breaker: over.breaker` 在 `exactOptionalPropertyTypes` 下会把
    //    `undefined` 也传进去，语义上就分不清"没传"与"传了 undefined"。
    ...(over.breaker === undefined ? {} : { breaker: over.breaker }),
  });
  return {
    client,
    sink,
    get calls(): number {
      return count;
    },
    setFetch: (f: (n: number) => Promise<{ status: number; body?: string }>): void => {
      impl = f;
    },
    at: (ms: number): void => {
      clock = ms;
    },
  };
}

describe('createFetchClient：熔断接线（默认开启，可显式关闭）', () => {
  it('默认就带熔断：连续失败到阈值后**不再打上游**，直接抛 CircuitOpenError', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 503 }) });
    for (let i = 0; i < BP.failureThreshold; i += 1) await h.client.send(POST_NO_KEY);
    expect(h.calls).toBe(BP.failureThreshold);

    await expect(h.client.send(POST_NO_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    // 🔒 熔断的全部价值就在这一行：**一次网络往返都没发生**。
    //    没有它的话，"保护上游"只是少重试几次，上游照样被砸。
    expect(h.calls).toBe(BP.failureThreshold);
  });

  it('抛出的错误带 key 与还要等多久（调用方能区分"被熔断"与"上游报错"）', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 503 }) });
    for (let i = 0; i < BP.failureThreshold; i += 1) await h.client.send(POST_NO_KEY);

    await expect(h.client.send(POST_NO_KEY)).rejects.toMatchObject({
      name: 'CircuitOpenError',
      key: 'api.stripe.test',
      retryAfterMs: BP.cooldownMs,
    });
  });

  it('冷却过后放行**一个**探测；探测成功 → 完全恢复', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 503 }) });
    for (let i = 0; i < BP.failureThreshold; i += 1) await h.client.send(POST_NO_KEY);
    await expect(h.client.send(POST_NO_KEY)).rejects.toBeInstanceOf(CircuitOpenError);

    h.at(BP.cooldownMs + 1_000); // 推过冷却期
    h.setFetch(async () => ({ status: 200, body: 'ok' }));
    const res = await h.client.send(POST_NO_KEY);
    expect(res.status).toBe(200);

    // 恢复之后，再失败也不会立刻被拒（计数已清零）
    h.setFetch(async () => ({ status: 503 }));
    await h.client.send(POST_NO_KEY);
    await expect(h.client.send(POST_NO_KEY)).resolves.toMatchObject({ status: 503 });
  });

  it('按主机隔离：一个上游跳闸，另一个照常打', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 503 }) });
    for (let i = 0; i < BP.failureThreshold; i += 1) await h.client.send(POST_NO_KEY);
    await expect(h.client.send(POST_NO_KEY)).rejects.toBeInstanceOf(CircuitOpenError);

    // 换主机：不受影响（否则"Stripe 挂了导致微信也不能用"，这是连坐事故）
    await expect(h.client.send(POST_NO_KEY_OTHER_HOST)).resolves.toMatchObject({ status: 503 });
  });

  it('4xx 不跳闸（上游健康地答复了一个错误请求，是我们的问题）', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 400 }) });
    for (let i = 0; i < BP.failureThreshold * 2; i += 1) await h.client.send(POST_NO_KEY);
    // 全部尝试都成功发出（阈值 × 2 次也没有一次被拒）
    expect(h.calls).toBe(BP.failureThreshold * 2);
  });

  /**
   * B4 / AJ-200：这条**反过来**了——一个逻辑请求只喂熔断**一次**。
   *
   * @why 旧断言钉的是"每次尝试都计入"，于是"一个用户的一次失败"在熔断眼里是 3 次，
   *      阈值 5 意味着**两位用户先后遇到就能跳闸**，跳闸后 30 秒内建会话 / 退款 /
   *      作废会话 / 拒付反查全部快速失败——机构的一次抖动被我们自己放大成全局故障。
   *      判据：阈值 5 ⇒ 需要 **5 个逻辑请求**才跳闸（按"尝试"粒度 2 个就够）。
   * @why 用**超时**而不是 503：B4 之后 503 一次都不重试，"一个请求打满 3 次"
   *      这件事就不成立了，这条用例会退化成数请求个数。
   */
  it('一个逻辑请求**只记一次**（重试的 3 次尝试不各算一次）', async () => {
    const h = breakerHarness({
      fetch: async () => {
        throw timeoutError();
      },
    });
    for (let i = 0; i < BP.failureThreshold - 1; i += 1) {
      await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    expect(h.calls).toBe(P.maxAttempts * (BP.failureThreshold - 1));
    // 第 5 个请求把计数推到阈值：它自己仍以超时失败（跳闸发生在它**结束**时）
    await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    // 第 6 个请求才被拦下
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('重试**之前**也会问熔断：half_open 的探测名额不会被同一条请求打满（B4/AJ-200）', async () => {
    // @why 旧实现只在循环外问一次，于是"放 1 个探测"实际会被同一条请求打 3 次，
    //      "刚恢复的上游"立刻被砸回去。判据：冷却结束后的那条探测请求，
    //      第 1 次尝试放行、第 2 次就被拦 ⇒ 只多打 1 次就抛 CircuitOpenError。
    let n = 0;
    const h = breakerHarness({
      fetch: async () => {
        n += 1;
        throw timeoutError();
      },
    });
    for (let i = 0; i < BP.failureThreshold; i += 1) {
      await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    const before = n;
    h.at(1_000_000); // 推过冷却 → half_open，放 1 个探测
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(n - before).toBe(1);
  });

  /**
   * R-01 / AJ-222：B4 的修复引入的回归——half_open 的探测失败后熔断**永久卡死**。
   *
   * @why 探测第 1 次尝试超时 → 判定可重试 → 第 2 圈 `before()` 因名额用完被拒 →
   *      直接抛 `CircuitOpenError`、**没有 `after()`**。状态停在 half_open 且名额已满，
   *      而 half_open 没有时间出口 ⇒ 此后这个主机的每个请求都被拒，直到进程重启。
   *      触发场景正是"Stripe 故障刚过冷却期、探测仍超时"——最需要自动恢复的那一刻。
   *      上面那条用例只断言到"抛 CircuitOpenError"为止，把卡死钉成了正确。
   *      判据：探测失败后再过一个冷却期，上游已恢复 ⇒ 必须能打出去并拿到 200。
   */
  it('🔴 half_open 探测以可重试失败告终 → 回到 open 重新计时，冷却后能恢复（不永久卡死）', async () => {
    const h = breakerHarness({
      fetch: async () => {
        throw timeoutError();
      },
    });
    for (let i = 0; i < BP.failureThreshold; i += 1) {
      await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    h.at(1_000_000); // 推过冷却 → half_open，放 1 个探测
    expect(h.sink.find('circuit_open')).toHaveLength(1);
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    // 🔒 探测的失败**被回写了**：half_open → open 再跳一次（第 2 条 circuit_open）。
    //    只靠状态机的探测超时兜底也能"最终恢复"，但那要白等一整个冷却期、且不留任何信号；
    //    这一行钉的是"调用方自己收尾"，兜底只是兜底。
    expect(h.sink.find('circuit_open')).toHaveLength(2);

    // 探测失败 = 上游仍不行：冷却期内继续拒绝，且**一次网络往返都不发生**
    const calls = h.calls;
    h.at(1_000_000 + BP.cooldownMs - 1_000);
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(h.calls).toBe(calls);

    // 再过一个冷却期、上游已恢复 → 放行探测并完全恢复
    h.at(1_000_000 + BP.cooldownMs * 3);
    h.setFetch(async () => ({ status: 200, body: 'ok' }));
    await expect(h.client.send(POST_WITH_KEY)).resolves.toMatchObject({ status: 200 });
    await expect(h.client.send(POST_WITH_KEY)).resolves.toMatchObject({ status: 200 });
  });

  it('🔴 half_open 探测得到 `unknown` → 名额退回（下一个请求接着探测，不卡死也不跳闸）', async () => {
    const h = breakerHarness({
      fetch: async () => {
        throw timeoutError();
      },
    });
    for (let i = 0; i < BP.failureThreshold; i += 1) {
      await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    h.at(1_000_000);
    h.setFetch(async () => ({ status: 199 })); // httpStatusKind → 'unknown'
    // 这条探测自己的出口是 CircuitOpenError：199 被判可重试，第 2 圈因名额已占被拒
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    // 看不懂的探测结果：既不算恢复也不算失败——但名额必须退回，否则下一个请求永远被拒
    h.setFetch(async () => ({ status: 200, body: 'ok' }));
    await expect(h.client.send(POST_WITH_KEY)).resolves.toMatchObject({ status: 200 });
  });

  it('`unknown` **不动**熔断状态（既不复位也不计入，B4/AJ-200）', async () => {
    // @why 旧实现把 unknown 当成功 → 夹在连续失败之间的几次 unknown 会把计数**清零**，
    //      于是"上游一直在坏、中间夹着认不出的失败"永远跳不了闸——熔断在最需要它时是瞎的。
    //      判据：4 次真失败 + 1 次 unknown，之后**再来 1 次**真失败就该跳闸；
    //      若 unknown 清零了计数，这里会一路放行。
    const h = breakerHarness({
      fetch: async () => {
        throw timeoutError();
      },
    });
    for (let i = 0; i < BP.failureThreshold - 1; i += 1) {
      await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    h.setFetch(async () => ({ status: 199 })); // httpStatusKind → 'unknown'
    await h.client.send(POST_WITH_KEY);
    h.setFetch(async () => {
      throw timeoutError();
    });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(h.client.send(POST_WITH_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('`breaker: null` 显式关闭 → 一直打（不抛 CircuitOpenError）', async () => {
    const h = breakerHarness({ fetch: async () => ({ status: 503 }), breaker: null });
    for (let i = 0; i < BP.failureThreshold * 2; i += 1) {
      await expect(h.client.send(POST_NO_KEY)).resolves.toMatchObject({ status: 503 });
    }
    expect(h.calls).toBe(BP.failureThreshold * 2);
  });

  it('注入的 breaker 被**直接使用**（不再自己造一个默认实例）', async () => {
    // 注入一个阈值只有 2 的：若实现忽略了注入、仍用默认 5，这条会红
    const h = breakerHarness({
      fetch: async () => ({ status: 503 }),
      breaker: createCircuitBreaker({
        policy: { failureThreshold: 2, cooldownMs: 60_000, halfOpenMaxProbes: 1 },
      }),
    });
    await h.client.send(POST_NO_KEY);
    await h.client.send(POST_NO_KEY); // 第 2 次失败 → 跳闸
    await expect(h.client.send(POST_NO_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('跳闸记 `http_outbound_circuit_open`，且**不混进** `http_outbound` 统计', async () => {
    // @why 分开记的理由是**指标会失准**：`http_outbound` 被当成"我们打了一次上游"来统计，
    //     而熔断拒绝时一次网络往返都没有。混进去会稀释"上游超时率"这类指标，
    //     表现是"上游看起来比实际健康"。
    const h = breakerHarness({ fetch: async () => ({ status: 503 }) });
    for (let i = 0; i < BP.failureThreshold; i += 1) await h.client.send(POST_NO_KEY);
    const before = h.sink.find('http_outbound').length;

    await expect(h.client.send(POST_NO_KEY)).rejects.toBeInstanceOf(CircuitOpenError);
    const row = h.sink.find('http_outbound_circuit_open')[0];
    expect(row?.result).toBe('circuit_open');
    expect(row?.ctx).toMatchObject({
      key: 'api.stripe.test',
      state: 'open',
      retry_after_ms: BP.cooldownMs,
    });
    // 不混进 http_outbound
    expect(h.sink.find('http_outbound')).toHaveLength(before);
    // 日志里不能出现查询串 / 鉴权头（脱敏红线在接线点同样成立）
    expect(h.sink.lines.join('\n')).not.toContain('sk_live_secret');
  });
});
