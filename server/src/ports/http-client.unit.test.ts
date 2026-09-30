/**
 * 职责：**重试判定**的 L0 用例（F12 第一单元）——钉住"什么时候能重试"。
 *
 * @why 重试是**唯一一种"加了之后会让事情更糟"的容错**：
 *      不重试最多是失败（用户重试、客服补单），而**错的重试**会制造出
 *      本来不存在的第二次扣款——且上下游都认为自己是第一次，对账表上两条记录都"合法"。
 *      这类事故不可回滚，所以规则必须先于实现被钉死。
 *
 * @why 这些规则写成**纯函数**而不是塞进客户端实现：
 *      判定规则是这个模块里唯一有业务含义的部分（其余都是转发），
 *      纯函数才能在不联网、不起服务的前提下穷举边界。与 `payloadHash` /
 *      `matchesScope` 同一套做法（@see docs/自主决策记录.md AJ-47）。
 *
 * @limitation 只验**判定**，不验"重试真的发出了第二次请求"——那是实现层的事
 *             （F12 第二单元，`adapters/http/fetch-client.ts`）。
 */
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  classifyHttpFailure,
  DEFAULT_RETRY_POLICY,
  httpStatusKind,
  shouldRetry,
  type HttpFailureKind,
  type HttpRequest,
  type RetryPolicy,
} from './http-client.js';

/** 固定的策略：抖动关掉，延迟可精确断言。 */
const P: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 };

function post(headers?: Record<string, string>): HttpRequest {
  return { method: 'POST', url: 'https://api.stripe.test/v1/x', ...(headers ? { headers } : {}) };
}

const GET: HttpRequest = { method: 'GET', url: 'https://api.stripe.test/v1/x' };

describe('httpStatusKind（状态码 → 失败分类）', () => {
  it('2xx / 3xx 是「没失败」', () => {
    for (const s of [200, 201, 204, 302]) expect(httpStatusKind(s)).toBe('none');
  });

  it('429 单独一类：上游明确**没有处理**（只是让你慢点）', () => {
    expect(httpStatusKind(429)).toBe('rate_limited');
  });

  it('5xx 是"上游自己说错了"；4xx 是"我们的请求有问题"', () => {
    expect(httpStatusKind(500)).toBe('server_error');
    expect(httpStatusKind(502)).toBe('server_error');
    expect(httpStatusKind(503)).toBe('server_error');
    expect(httpStatusKind(400)).toBe('client_error');
    expect(httpStatusKind(401)).toBe('client_error');
    expect(httpStatusKind(402)).toBe('client_error');
    expect(httpStatusKind(404)).toBe('client_error');
  });

  it('认不出来的状态保守归为 unknown（不重试好过重复扣款）', () => {
    expect(httpStatusKind(100)).toBe('unknown');
  });
});

describe('classifyHttpFailure（异常 → 失败分类）', () => {
  it('超时：DOMException TimeoutError / AbortError / ETIMEDOUT', () => {
    expect(classifyHttpFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(
      'timeout',
    );
    expect(classifyHttpFailure(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(
      'timeout',
    );
    expect(classifyHttpFailure({ code: 'ETIMEDOUT' })).toBe('timeout');
  });

  it('网络层：TypeError（fetch failed）/ ECONNREFUSED / ENOTFOUND', () => {
    expect(
      classifyHttpFailure(Object.assign(new Error('fetch failed'), { name: 'TypeError' })),
    ).toBe('network');
    expect(classifyHttpFailure({ code: 'ECONNREFUSED' })).toBe('network');
    expect(classifyHttpFailure({ code: 'ENOTFOUND' })).toBe('network');
  });

  it('认不出来 → unknown（**保守**，按"可能已到达"处理）', () => {
    expect(classifyHttpFailure(new Error('boom'))).toBe('unknown');
    expect(classifyHttpFailure('not an error')).toBe('unknown');
    expect(classifyHttpFailure(undefined)).toBe('unknown');
  });
});

describe('backoffMs（指数退避 + 抖动）', () => {
  it('指数增长并封顶（上游长时间故障时不能把重试推到几分钟后）', () => {
    expect(backoffMs(1, P)).toBe(200);
    expect(backoffMs(2, P)).toBe(400);
    expect(backoffMs(3, P)).toBe(800);
    expect(backoffMs(99, P)).toBe(P.maxDelayMs);
  });

  it('抖动由**注入**的随机源决定：rand=0 不抖、rand=1 抖满', () => {
    // @why 随机源注入而不是函数内部 Math.random：ports 层受纯度门禁约束（AJ-50），
    //      而且注入之后"抖动是否生效"本身才可测——否则只能测"值在某个区间里"。
    expect(backoffMs(1, { ...P, jitterRatio: 0.5 }, () => 0)).toBe(200);
    expect(backoffMs(1, { ...P, jitterRatio: 0.5 }, () => 1)).toBe(300);
  });

  it('随机源返回越界值（负数 / 大于 1）时延迟不会变成负数', () => {
    expect(backoffMs(1, { ...P, jitterRatio: 0.5 }, () => -5)).toBe(200);
    expect(backoffMs(1, { ...P, jitterRatio: 0.5 }, () => 99)).toBe(300);
  });

  it('attempt < 1（不该发生）返回 0，不抛', () => {
    expect(backoffMs(0, P)).toBe(0);
  });
});

describe('shouldRetry：🔒 POST 无幂等键 → 绝不重试（重复扣款红线）', () => {
  it('超时 / 5xx / 网络错误 / 未知 —— POST 无幂等键时**全部不重试**', () => {
    for (const failure of ['timeout', 'server_error', 'network', 'unknown'] as const) {
      const d = shouldRetry(post(), failure, 1, P);
      expect(d.retry, `${failure} 不该重试`).toBe(false);
      expect(d.reason).toContain('幂等键');
    }
  });

  it('带了别的不相关头（如 authorization）**也不算**有幂等键', () => {
    /**
     * @why 这条不是凑覆盖率：真实形态就是"POST 带着 authorization / content-type，
     *      但忘了带幂等键"——如果只看"headers 非空"就放行，这个最常见的场景会直接重复扣款。
     */
    const d = shouldRetry(
      post({ authorization: 'Bearer sk', 'content-type': 'text/plain' }),
      'timeout',
      1,
      P,
    );
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('幂等键');
  });

  /**
   * B4 / AJ-200：**5xx 从这一组里拿掉**。
   * @why 旧断言把"5xx + 幂等键 → 重发"钉成了正确，而它在真 Stripe 上是白等——
   *      失败结果会按幂等键缓存（B3 / AJ-199），重发拿回的是同一个 500。
   *      5xx 的判定移到了下面专门的一组（听上游的 `Stripe-Should-Retry`）。
   */
  it('带上幂等键 → 超时 / 网络 / 未知 可重试（正确的用法必须走得通）', () => {
    for (const failure of ['timeout', 'network', 'unknown'] as const) {
      const d = shouldRetry(post({ 'idempotency-key': 'k-1' }), failure, 1, P);
      expect(d.retry, `${failure} 应当可重试`).toBe(true);
      expect(d.delayMs).toBe(200);
    }
  });

  it('🔒 5xx：没声明上游建议头 → **不重试**（重发拿回的是缓存的同一次失败，B4/AJ-200）', () => {
    const d = shouldRetry(post({ 'idempotency-key': 'k-1' }), 'server_error', 1, P);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('没声明');
  });

  it('🔒 5xx：声明了建议头，但上游说 false → 不重试', () => {
    const req = { ...post({ 'idempotency-key': 'k-1' }), retryAdviceHeader: 'stripe-should-retry' };
    const d = shouldRetry(req, 'server_error', 1, P, () => 0, {
      status: 500,
      body: '',
      headers: { 'stripe-should-retry': 'false' },
    });
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('false');
  });

  it('🔒 5xx：声明了建议头且上游说 true → 才重试（这是唯一该重试的 5xx）', () => {
    const req = { ...post({ 'idempotency-key': 'k-1' }), retryAdviceHeader: 'stripe-should-retry' };
    const d = shouldRetry(req, 'server_error', 1, P, () => 0, {
      status: 500,
      body: '',
      headers: { 'stripe-should-retry': 'true' },
    });
    expect(d.retry).toBe(true);
  });

  it('🔒 5xx：声明了建议头但**响应里没有**这个头 → 按 false 处理（不重试）', () => {
    const req = { ...post({ 'idempotency-key': 'k-1' }), retryAdviceHeader: 'stripe-should-retry' };
    const d = shouldRetry(req, 'server_error', 1, P, () => 0, { status: 503, body: '' });
    expect(d.retry).toBe(false);
  });

  it('头名**大小写不敏感**：`Idempotency-Key` 同样算有', () => {
    expect(shouldRetry(post({ 'Idempotency-Key': 'k-1' }), 'timeout', 1, P).retry).toBe(true);
  });

  it('429 例外：上游明确没处理，POST 无幂等键也能重试', () => {
    const d = shouldRetry(post(), 'rate_limited', 1, P);
    expect(d.retry).toBe(true);
  });
});

describe('shouldRetry：其余停止条件', () => {
  it('4xx（非 429）一律不重试——重试一万次也不会变', () => {
    const d = shouldRetry(post({ 'idempotency-key': 'k-1' }), 'client_error', 1, P);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('4xx');
  });

  it('没失败就不重试', () => {
    expect(shouldRetry(GET, 'none', 1, P).retry).toBe(false);
  });

  it('尝试次数用尽 → 不重试（reason 里带上次数，排障要看）', () => {
    const d = shouldRetry(GET, 'server_error', P.maxAttempts, P);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain(`${P.maxAttempts}/${P.maxAttempts}`);
  });

  it('GET 不要求幂等键（无副作用，重试天生安全）', () => {
    expect(shouldRetry(GET, 'timeout', 1, P).retry).toBe(true);
  });

  it('默认策略就是「最多 3 次尝试」且带 20% 抖动', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_POLICY.jitterRatio).toBeGreaterThan(0);
    // 默认抖动下的延迟落在 [raw, raw*1.2] 区间内（rand 固定 0.5 → 只抖一半）
    const delay = backoffMs(1, DEFAULT_RETRY_POLICY, () => 0.5);
    expect(delay).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs);
    expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs * 1.2);
  });
});

/** 与 `HttpFailureKind` 全集做一次交叉，防止将来加了分类却忘了在判定里处理。 */
describe('分类全集（防漏处理）', () => {
  it('每个非 none 的分类都有一条明确的判定结果（不会落到默认分支）', () => {
    const kinds: HttpFailureKind[] = [
      'none',
      'timeout',
      'network',
      'server_error',
      'rate_limited',
      'client_error',
      'unknown',
    ];
    for (const k of kinds) {
      // GET 无副作用，用它单测"分类本身"：none / client_error / server_error 会停
      // （server_error 自 B4 / AJ-200 起：**没声明上游建议头就不重试**）
      const d = shouldRetry(GET, k, 1, P);
      if (k === 'none' || k === 'client_error' || k === 'server_error') {
        expect(d.retry).toBe(false);
      } else {
        expect(d.retry, `${k} 应可重试`).toBe(true);
      }
    }
  });
});
