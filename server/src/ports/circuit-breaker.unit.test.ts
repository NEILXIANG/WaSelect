/**
 * 职责：熔断器**状态机**的 L0 单测（纯函数，不需要网络、不需要时间）。
 *
 * @why 熔断是**唯一一种"用一个失败去换另一个失败"的容错**：它主动把可用的请求变成不可用。
 *      所以它判错的代价远高于重试判错——重试错了最多多花几秒，
 *      熔断错了是**上游其实已经好了、我们还在拒绝请求**（恢复慢），
 *      或者**上游明明是我们自己的 4xx、我们却把上游判死**（误伤）。
 *      这两类错误都不会抛异常，只会表现为"下单成功率莫名其妙地低"，必须有个地方能测。
 *
 * @how 全部用**注入的 `now`**（毫秒数）推进状态，不碰真实时钟。
 *      状态机是离散的：closed / open / half_open 三态 + 三个计数，
 *      用一组整数就能把整条生命周期走完。
 */
import { describe, expect, it } from 'vitest';
import {
  breakerKey,
  circuitAfter,
  circuitBefore,
  countsTowardTrip,
  DEFAULT_BREAKER_POLICY as P,
  initialCircuit,
  type CircuitSnapshot,
} from './circuit-breaker.js';

/** 从初始态连着失败 n 次。 */
function fail(n: number, start = 0): CircuitSnapshot {
  let s = initialCircuit();
  for (let i = 0; i < n; i += 1) s = circuitAfter(s, P, start, false);
  return s;
}

describe('countsTowardTrip：哪些失败该让上游"背锅"', () => {
  it('超时 / 网络错误 / 5xx / 429 计入（都是"上游现在不行"的信号）', () => {
    for (const k of ['timeout', 'network', 'server_error', 'rate_limited'] as const) {
      expect(countsTowardTrip(k), k).toBe(true);
    }
  });

  it('**4xx 不计入**——那是我们自己传错了参数，不是上游生病', () => {
    // 这条判错的表现是"我们一个 bug 把本来健康的上游判死"，且只在我们的 bug 修好后才恢复
    expect(countsTowardTrip('client_error')).toBe(false);
  });

  it('成功与"看不懂的错误"都不计入（看不懂就不跳闸，宁可不保护也不误伤）', () => {
    expect(countsTowardTrip('none')).toBe(false);
    expect(countsTowardTrip('unknown')).toBe(false);
  });
});

describe('closed → open：连续失败达到阈值才跳闸', () => {
  it('初始是 closed、计数为 0', () => {
    expect(initialCircuit()).toEqual({
      state: 'closed',
      failureCount: 0,
      openedAtMs: null,
      halfOpenProbes: 0,
    });
  });

  it('没到阈值：**继续放行**，只累加计数', () => {
    const s = fail(P.failureThreshold - 1);
    expect(s.state).toBe('closed');
    expect(s.failureCount).toBe(P.failureThreshold - 1);
    expect(circuitBefore(s, P, 0).allowed).toBe(true);
  });

  it('到阈值 → open，并记录跳闸时刻', () => {
    const s = fail(P.failureThreshold, 1_000);
    expect(s.state).toBe('open');
    expect(s.openedAtMs).toBe(1_000);
  });

  it('成功会把计数清零（不是"累计历史失败数"）', () => {
    const s1 = fail(P.failureThreshold - 1);
    const s2 = circuitAfter(s1, P, 0, true);
    expect(s2).toEqual(initialCircuit());
  });
});

describe('open：拒绝请求，且在冷却期内**不**放行', () => {
  it('冷却未过 → 不放行（快速失败，不再消耗上游连接）', () => {
    const s = fail(P.failureThreshold, 1_000);
    expect(circuitBefore(s, P, 1_000 + P.cooldownMs - 1).allowed).toBe(false);
  });

  it('冷却刚过 → 转 half_open 并放行一个探测请求', () => {
    const s = fail(P.failureThreshold, 1_000);
    const r = circuitBefore(s, P, 1_000 + P.cooldownMs);
    expect(r.allowed).toBe(true);
    expect(r.next.state).toBe('half_open');
    expect(r.next.halfOpenProbes).toBe(1);
  });

  it('不放行时**不改状态**（判定必须是纯读，否则"看一眼"就等于放行了一个名额）', () => {
    const s = fail(P.failureThreshold, 1_000);
    const r = circuitBefore(s, P, 1_000 + 1);
    expect(r.next).toBe(s);
  });

  it('状态说 open 却**没有跳闸时刻**（不变量被破坏）→ 不放行（坏状态不得静默通过）', () => {
    // 正常路径造不出这个状态；它对应"状态被别处写坏了"。宁可卡住也不放行：
    // 放行的后果是"熔断形同虚设"，卡住的后果是"这个上游暂时不可用"——后者可发现、可告警。
    const broken: CircuitSnapshot = {
      state: 'open',
      failureCount: 9,
      openedAtMs: null,
      halfOpenProbes: 0,
    };
    expect(circuitBefore(broken, P, 0).allowed).toBe(false);
  });

  it('已是 open 时又记了一次失败 → 仍是 open 并**重新计时**（不会把冷却提前结束）', () => {
    const opened = fail(P.failureThreshold, 1_000);
    const again = circuitAfter(opened, P, 2_000, false);
    expect(again.state).toBe('open');
    expect(again.openedAtMs).toBe(2_000);
  });
});

describe('策略可调（默认值不是硬编码）', () => {
  it('`halfOpenMaxProbes: 2` 时连续放行两个探测，计数逐个累加', () => {
    const p = { ...P, halfOpenMaxProbes: 2 };
    const opened = fail(P.failureThreshold, 1_000);

    const r1 = circuitBefore(opened, p, 1_000 + P.cooldownMs);
    expect(r1.allowed).toBe(true);
    expect(r1.next.halfOpenProbes).toBe(1);

    const r2 = circuitBefore(r1.next, p, 1_000 + P.cooldownMs);
    expect(r2.allowed).toBe(true);
    expect(r2.next.halfOpenProbes).toBe(2);

    expect(circuitBefore(r2.next, p, 1_000 + P.cooldownMs).allowed).toBe(false);
  });
});

describe('half_open：只放探测请求，据此决定恢复还是再跳', () => {
  it('探测数用完后不再放行（防止"冷却一过就来一波洪峰"）', () => {
    const opened = fail(P.failureThreshold, 1_000);
    let s = opened;
    for (let i = 0; i < P.halfOpenMaxProbes; i += 1) {
      const r = circuitBefore(s, P, 1_000 + P.cooldownMs);
      expect(r.allowed).toBe(true);
      s = r.next;
    }
    expect(circuitBefore(s, P, 1_000 + P.cooldownMs).allowed).toBe(false);
  });

  it('探测成功 → 回到 closed 并**完全复位**（计数、跳闸时刻、探测数）', () => {
    const opened = fail(P.failureThreshold, 1_000);
    const probing = circuitBefore(opened, P, 1_000 + P.cooldownMs).next;
    expect(circuitAfter(probing, P, 2_000, true)).toEqual(initialCircuit());
  });

  it('探测失败 → 立刻再跳回 open，且**重新计时**（不是沿用旧时刻）', () => {
    const opened = fail(P.failureThreshold, 1_000);
    const probing = circuitBefore(opened, P, 1_000 + P.cooldownMs).next;
    const again = circuitAfter(probing, P, 5_000, false);
    expect(again.state).toBe('open');
    expect(again.openedAtMs).toBe(5_000);
    // 因此：5s 跳闸的这一次，要等到 5s+cooldown 才能再探测
    expect(circuitBefore(again, P, 5_000 + P.cooldownMs - 1).allowed).toBe(false);
  });
});

describe('breakerKey：按**上游主机**分组（粒度是契约的一部分）', () => {
  it('同一主机的不同路径 / 不同查询串 → 同一个 key', () => {
    expect(breakerKey('https://api.stripe.com/v1/checkout/sessions')).toBe(
      breakerKey('https://api.stripe.com/v1/refunds?limit=1'),
    );
  });

  it('不同主机 → 不同 key（一个上游挂了不该连坐别的）', () => {
    expect(breakerKey('https://api.stripe.com/v1/x')).not.toBe(
      breakerKey('https://api.weixin.qq.com/v3/x'),
    );
  });

  it('解析不了的 URL → 落到一个固定桶（不抛错，也不让"每次一个新桶"导致永不跳闸）', () => {
    expect(breakerKey('not-a-url')).toBe('unknown');
    expect(breakerKey('')).toBe('unknown');
  });
});
