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
import { countsTowardTrip } from './circuit-breaker.js';
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

  it('🔴 连接被对端掐断（ECONNRESET / EPIPE）归 network，不能落到 unknown（AJ-299）', () => {
    // @why 这两个 code 是"连接已建立、随后被对端掐断"——正是"请求**可能已经到达**上游"
    //      这一语义里最常见的形态，与 ECONNREFUSED / ENOTFOUND 同类。
    //      落到 `unknown` 的代价**不在重试侧**（两者都要求幂等键才重试，表现一样），
    //      而在熔断侧：`countsTowardTrip('unknown') === false`，于是上游持续重置连接时
    //      熔断器**永远不跳闸**——故障被当成"健康的单次抖动"，重试放大照旧发生。
    //      分类表漏掉它，表现为"有一类上游故障我们从不自我保护"，且不报任何错。
    expect(classifyHttpFailure({ code: 'ECONNRESET' })).toBe('network');
    expect(classifyHttpFailure({ code: 'EPIPE' })).toBe('network');
    // 直接钉住后果（而不是只钉分类名）：这条才是"漏了会怎样"的可执行证据
    expect(countsTowardTrip(classifyHttpFailure({ code: 'ECONNRESET' }))).toBe(true);
    expect(countsTowardTrip(classifyHttpFailure({ code: 'EPIPE' }))).toBe(true);
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

  /**
   * 🔴 AJ-314（第二轮审查 PAY2-05 的修法）：B4 / AJ-200 那条"5xx 要上游建议才重试"
   * **只对带幂等键的 POST 成立**。
   *
   * @why 它成立的理由是"重发 → 命中机构按幂等键缓存的失败 → 拿回同一个 503"。
   *      GET 不带幂等键、机构也不缓存 GET，重发拿到的是上游**当前**的结果。
   *      套到 GET 上的后果是静默的韧性回退：Stripe 侧四处 GET（拒付反查 PI、
   *      退款前反查会话、查退款状态、查会话状态）遇一次瞬时 5xx 就直接失败——
   *      拒付回调回 500 → 机构按退避重发约三天 → **持续失败的端点被停用**，
   *      这正是 B5 / AJ-198 花力气堵住的那一条，却在 B4 里被重新打开。
   * @why 这条与下面"带幂等键的 POST 遇 5xx 不重试"**并存**，而不是互相推翻：
   *      两条钉的是判据的两个半边——半边是方法，半边是上游建议。
   */
  it('🔴 GET 遇 5xx → 重试（B4 的理由是"拿回缓存的失败"，而 GET 没有按键缓存）', () => {
    const d = shouldRetry(GET, 'server_error', 1, P);
    expect(d.retry).toBe(true);
    // 反证：不是因为"没声明建议头"被拦下的（那正是修复前 GET 拿到的理由）
    expect(d.reason).not.toContain('没声明');
  });

  it('🔴 PUT / DELETE 遇 5xx 同样重试（对象存储的上传/删除，按 HTTP 语义幂等）', () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      const d = shouldRetry({ method, url: 'https://r2.test/bucket/key' }, 'server_error', 1, P);
      expect(d.retry, `${method} 应当可重试`).toBe(true);
    }
  });

  /**
   * 🔴 PAY3-07：一次性动作（微信 code2session）声明"只发一次"。
   * @why 429 是唯一一个"连 POST 无幂等键都能重试"的例外——它靠"上游明确没处理"成立。
   *      但"只发一次"是更强的声明：**无论上游有没有处理，第二次都不该发出去**
   *      （这个 GET 会消耗 code，第二次拿回的就是"code 已使用"）。
   *      所以这条把 429 一起钉住，防止有人把它理解成"只拦可重试的那几类"。
   */
  it('🔴 声明只发一次（maxAttempts=1）→ 连 429 也不重试，且 reason 说明是声明而非试满', () => {
    const once: RetryPolicy = { ...P, maxAttempts: 1 };
    for (const kind of [
      'network',
      'timeout',
      'server_error',
      'rate_limited',
    ] as HttpFailureKind[]) {
      const d = shouldRetry(GET, kind, 1, once);
      expect(d.retry).toBe(false);
      expect(d.reason).toContain('只发一次'); // 不是"尝试次数用尽"——那句会误导排障
    }
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
      // GET 无副作用，用它单测"分类本身"：只有 none / client_error 会停。
      // ⚠️ `server_error` **不**在这个停下的集合里（AJ-314）：B4 那条"要上游建议才重试"
      //    只对带幂等键的 POST 成立，把它算进 GET 的停止集合正是本条修复掉的东西。
      const d = shouldRetry(GET, k, 1, P);
      if (k === 'none' || k === 'client_error') {
        expect(d.retry).toBe(false);
      } else {
        expect(d.retry, `${k} 应可重试`).toBe(true);
      }
    }
  });

  /**
   * 🔴 AJ-314：5xx 是**唯一**一个"重试与否取决于方法"的分类，两边都要钉。
   *
   * @why 上面那条只用 GET 交叉分类，会把 5xx 钉成"可重试"；而带幂等键的 POST 遇 5xx
   *      在没有上游建议头时**不**重试（B4 / AJ-200）。只留任何一条，将来"改了方法判定"
   *      或"改了建议头判定"的其中一半都不会变红——这正是本条要堵的形态：
   *      规则其实有两条半边，测试却只写了半边。
   * @why 顺带断言"除 5xx 之外 GET 与 POST 判定一致"：将来若有人给某个分类也加上方法分支，
   *      这里会立刻变红，逼他把理由写进注释（方法不该悄悄成为第二条判据）。
   */
  it('🔴 5xx 是唯一随方法分叉的分类：GET 重试、无建议头的 POST 不重试', () => {
    const kinds: HttpFailureKind[] = [
      'timeout',
      'network',
      'server_error',
      'rate_limited',
      'unknown',
    ];
    for (const k of kinds) {
      const get = shouldRetry(GET, k, 1, P).retry;
      const postNoAdvice = shouldRetry(post({ 'idempotency-key': 'k-1' }), k, 1, P).retry;
      if (k === 'server_error') {
        expect(get, 'GET 的 5xx 应可重试（AJ-314）').toBe(true);
        expect(postNoAdvice, '无建议头的 POST 5xx 不应重试（B4/AJ-200）').toBe(false);
      } else {
        expect(get, `${k}：GET 与 POST 不该分叉`).toBe(postNoAdvice);
      }
    }
  });
});
