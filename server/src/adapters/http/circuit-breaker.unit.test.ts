/**
 * 职责：熔断器**状态存放**的 L0 单测（不碰网络）。
 *
 * @why 状态机是纯的（已在 `ports/circuit-breaker.unit.test.ts` 验过），但"存放"这一段有自己的坑：
 *      ① **跨请求**：状态必须活在一次 `send()` 之外，否则熔断永远是初始值——
 *         那是最容易写错又最不容易发现的一种（每个请求都"第一次失败"，永远跳不了闸）；
 *      ② **跨 key 隔离**：一个上游跳闸不该连坐另一个（否则 Stripe 挂了微信也跟着不能用）；
 *      ③ **跳闸/恢复要有信号**：这是唯一能让人知道"我们正在拒绝请求"的地方，
 *         没有日志的话，故障表现只是"下单成功率莫名下降"。
 *
 * @how `now` 注入成可控整数，把 30 秒冷却走完只用一次赋值。
 */
import { describe, expect, it } from 'vitest';
import type { BreakerPolicy, CircuitSnapshot } from '../../ports/circuit-breaker.js';
import { DEFAULT_BREAKER_POLICY } from '../../ports/circuit-breaker.js';
import { createLogger } from '../../logger.js';
import { MemorySink } from '../../../../test/helpers/memory-sink.js';
import { CircuitOpenError, createCircuitBreaker } from './circuit-breaker.js';

const P: BreakerPolicy = DEFAULT_BREAKER_POLICY;

function harness(over: { policy?: Partial<BreakerPolicy> } = {}) {
  const sink = new MemorySink();
  let nowMs = 1_000;
  const changes: string[] = [];
  const breaker = createCircuitBreaker({
    policy: { ...P, ...over.policy },
    now: () => nowMs,
    logger: createLogger({ env: 'test', destination: sink }),
    onStateChange: (key, from, to) => changes.push(`${key}:${from}->${to}`),
  });
  return { breaker, sink, changes, at: (ms: number) => (nowMs = ms) };
}

/** 连着记 n 次"该计入的失败"。 */
function trip(breaker: ReturnType<typeof createCircuitBreaker>, key: string, n: number): void {
  for (let i = 0; i < n; i += 1) breaker.after(key, 'server_error');
}

describe('状态跨请求存活（熔断的全部意义）', () => {
  it('第一次请求放行；失败累计到阈值后**后续请求**被拒', () => {
    const { breaker } = harness();
    expect(breaker.before('a.com').allowed).toBe(true);

    trip(breaker, 'a.com', P.failureThreshold);
    const gate = breaker.before('a.com');
    expect(gate.allowed).toBe(false);
    expect(gate.state).toBe('open');
  });

  it('跳闸后给出**还要等多久**（调用方能据此提示用户稍后再试）', () => {
    const { breaker, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    const gate = breaker.before('a.com');
    expect(gate.retryAfterMs).toBe(P.cooldownMs); // 1_000 + 30_000 - 1_000

    at(1_000 + 10_000);
    expect(breaker.before('a.com').retryAfterMs).toBe(P.cooldownMs - 10_000);
  });

  it('冷却过后放行一个探测；探测成功 → 完全复位（计数与跳闸时刻都清零）', () => {
    const { breaker, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    expect(breaker.before('a.com').allowed).toBe(false);

    at(1_000 + P.cooldownMs);
    expect(breaker.before('a.com').allowed).toBe(true);
    breaker.after('a.com', 'none'); // 探测成功

    expect(breaker.snapshot('a.com')).toEqual({
      state: 'closed',
      failureCount: 0,
      openedAtMs: null,
      halfOpenProbes: 0,
    } satisfies CircuitSnapshot);
  });

  /**
   * R-01 / AJ-222：这条的期望值**反过来**了（原来钉的是 0）。
   * @why half_open 现在有探测超时出口：名额用完后最多再等一个冷却期就会开新一轮探测，
   *      所以"还要等多久"有了真实答案。报 0 会让调用方以为"马上重试就行"，而实际上会一直被拒。
   */
  it('half_open 的探测名额用完 → 等待时间 = 距探测超时还有多久（不再报 0）', () => {
    const { breaker, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    at(1_000 + P.cooldownMs);
    expect(breaker.before('a.com').allowed).toBe(true); // 第一个探测
    const gate = breaker.before('a.com'); // 名额用完
    expect(gate.allowed).toBe(false);
    expect(gate.state).toBe('half_open');
    expect(gate.retryAfterMs).toBe(P.cooldownMs);
    // 探测超时一到就放行新一轮（不需要任何 after）
    at(1_000 + P.cooldownMs * 2);
    expect(breaker.before('a.com').allowed).toBe(true);
  });

  it('half_open 的探测得到 unknown → 名额退回；closed / open 下的 unknown 仍然什么都不做', () => {
    const { breaker, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    breaker.after('a.com', 'unknown'); // open 下：不动（不重新计时）
    expect(breaker.snapshot('a.com').openedAtMs).toBe(1_000);
    at(1_000 + P.cooldownMs);
    expect(breaker.before('a.com').allowed).toBe(true); // 探测
    breaker.after('a.com', 'unknown');
    expect(breaker.snapshot('a.com')).toMatchObject({ state: 'half_open', halfOpenProbes: 0 });
    expect(breaker.before('a.com').allowed).toBe(true); // 下一个请求接着探测
  });

  it('从没见过的 key 都是全新的 closed（不会出现"共享一个初始状态"）', () => {
    const { breaker } = harness();
    breaker.before('b.com');
    trip(breaker, 'a.com', P.failureThreshold);
    expect(breaker.before('a.com').allowed).toBe(false);
    expect(breaker.before('b.com').allowed).toBe(true);

    // ⚠️ 顺带断言 `snapshot()` 对**没见过的 key** 也返回初始态，而不是 undefined：
    //    排查"到底是谁在拒绝"时会按猜测的 key 去查，查一个没见过的字段名得到 undefined
    //    会让排障的人把 undefined 当成"这个上游没状态"，从而完全查错方向。
    expect(breaker.snapshot('never-seen.com')).toEqual({
      state: 'closed',
      failureCount: 0,
      openedAtMs: null,
      halfOpenProbes: 0,
    } satisfies CircuitSnapshot);
  });
});

describe('按上游隔离（一个挂了不连坐）', () => {
  it('a.com 跳闸后 b.com 照常放行', () => {
    const { breaker } = harness();
    trip(breaker, 'a.com', P.failureThreshold);
    expect(breaker.before('a.com').allowed).toBe(false);
    expect(breaker.before('b.com').allowed).toBe(true);
  });

  it('`snapshots()` 能一次看到全部（排障时"到底是谁在拒绝"）', () => {
    const { breaker } = harness();
    trip(breaker, 'a.com', P.failureThreshold);
    breaker.before('b.com');
    expect(Object.keys(breaker.snapshots()).sort()).toEqual(['a.com', 'b.com']);
  });
});

describe('哪些结果算"上游好了"', () => {
  it('**4xx 不跳闸**（上游正确地答复了一个错误的请求）', () => {
    const { breaker } = harness();
    for (let i = 0; i < P.failureThreshold * 2; i += 1) breaker.after('a.com', 'client_error');
    expect(breaker.before('a.com').allowed).toBe(true);
    expect(breaker.snapshot('a.com').failureCount).toBe(0);
  });

  it('看不懂的 `unknown` 也不跳（看不懂就不该触发"拒绝一切"）', () => {
    const { breaker } = harness();
    for (let i = 0; i < P.failureThreshold * 2; i += 1) breaker.after('a.com', 'unknown');
    expect(breaker.before('a.com').allowed).toBe(true);
  });

  it('超时 / 网络错误 / 429 都计入', () => {
    for (const kind of ['timeout', 'network', 'rate_limited'] as const) {
      const { breaker } = harness();
      for (let i = 0; i < P.failureThreshold; i += 1) breaker.after('a.com', kind);
      expect(breaker.before('a.com').allowed, kind).toBe(false);
    }
  });
});

describe('可观测性：跳闸与恢复必须留下信号', () => {
  it('跳闸记 warn，并带上 key 与阈值', () => {
    const { breaker, sink } = harness();
    trip(breaker, 'a.com', P.failureThreshold);

    const row = sink.find('circuit_open')[0];
    expect(row?.level).toBe('warn');
    expect(row?.ctx).toMatchObject({ key: 'a.com', threshold: P.failureThreshold });
  });

  it('恢复记 info（否则没人知道"已经好了"）', () => {
    const { breaker, sink, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    at(1_000 + P.cooldownMs);
    breaker.before('a.com');
    breaker.after('a.com', 'none');

    const row = sink.find('circuit_closed')[0];
    expect(row?.level).toBe('info');
    expect(row?.ctx).toMatchObject({ key: 'a.com' });
  });

  it('状态迁移回调按序触发（告警接的就是这个）', () => {
    const { breaker, changes, at } = harness();
    at(1_000);
    trip(breaker, 'a.com', P.failureThreshold);
    at(1_000 + P.cooldownMs);
    breaker.before('a.com');
    breaker.after('a.com', 'none');

    // 三次迁移：跳闸 → 冷却后转 half_open（放行探测）→ 探测成功回到 closed
    expect(changes).toEqual([
      'a.com:closed->open',
      'a.com:open->half_open',
      'a.com:half_open->closed',
    ]);
  });
});

describe('默认构造（什么都不注入也要能用）', () => {
  it('真实时钟 + 默认策略 + 无日志 + 无回调：放行 → 跳闸 → 拒绝', () => {
    // @why 这条不是凑覆盖率：默认参数是"别人照最小用法接入时走的那条路"，
    //      它挂了的表现是"没配 logger 就崩"或"没传 now 就永远是 1970"。
    const b = createCircuitBreaker();
    expect(b.before('default.com').allowed).toBe(true);
    for (let i = 0; i < P.failureThreshold; i += 1) b.after('default.com', 'server_error');
    expect(b.before('default.com').allowed).toBe(false);
    expect(b.snapshot('default.com').state).toBe('open');
  });
});

describe('CircuitOpenError：让调用方能区分"被熔断"与"上游报错"', () => {
  it('带上 key 与还要等多久，且 `instanceof` 可用', () => {
    const err = new CircuitOpenError('a.com', 12_345);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.key).toBe('a.com');
    expect(err.retryAfterMs).toBe(12_345);
    expect(err.message).toContain('a.com');
  });
});
