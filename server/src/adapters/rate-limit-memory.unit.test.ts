/**
 * 职责：进程内限流存储的 L0 用例（I1-U3）——窗口滚动、key 隔离、容量驱逐三条语义。
 *
 * @why 容量驱逐（fail-open）必须钉住：它是"被攻击时不崩溃 vs 不放大拒绝服务"的取舍
 *      （rate-limit-memory.ts @limitation 三），改错了不报错——
 *      fail-closed 会让"伪造海量源 IP"变成全站锁定开关。
 *
 * @see adapters/rate-limit-memory.ts（被测）
 */
import { describe, expect, it } from 'vitest';
import { createMemoryRateLimitStore, RATE_LIMIT_MAX_KEYS } from './rate-limit-memory.js';

const T0 = Date.parse('2026-01-02T12:00:00.000Z');

describe('hit：窗口语义', () => {
  it('同窗口累加；跨窗口（now >= resetAtMs）重置为 1', () => {
    const s = createMemoryRateLimitStore();
    expect(s.hit('k', 60_000, T0).count).toBe(1);
    expect(s.hit('k', 60_000, T0 + 1_000).count).toBe(2);
    // 窗口边界（恰好 resetAtMs）= 新窗口
    expect(s.hit('k', 60_000, T0 + 60_000).count).toBe(1);
  });

  it('resetAtMs 是"当前窗口起点 + windowMs"（时钟对齐，不是从首次 hit 起算的滚动窗）', () => {
    const s = createMemoryRateLimitStore();
    const w = s.hit('k', 60_000, T0 + 37_000);
    expect(w.resetAtMs).toBe(T0 + 60_000);
  });

  it('不同 key 互不影响', () => {
    const s = createMemoryRateLimitStore();
    s.hit('a', 60_000, T0);
    s.hit('a', 60_000, T0);
    expect(s.hit('b', 60_000, T0).count).toBe(1);
    expect(s.hit('a', 60_000, T0).count).toBe(3);
  });
});

describe('容量保护（防内存被刷爆）', () => {
  it('超上限先清过期 key', () => {
    const s = createMemoryRateLimitStore({ maxKeys: 2 });
    // 两个过期 key（窗口已结束）
    s.hit('old-1', 60_000, T0 - 120_000);
    s.hit('old-2', 60_000, T0 - 60_000);
    expect(s.size()).toBe(2);
    // 新 key 触发清理：过期的两个被清掉，新 key 正常入列
    s.hit('new', 60_000, T0);
    expect(s.size()).toBe(1);
  });

  it('仍超上限时驱逐最老的活跃 key（fail-open），但**绝不驱逐当前 key**', () => {
    const s = createMemoryRateLimitStore({ maxKeys: 2 });
    s.hit('k1', 60_000, T0);
    s.hit('k2', 60_000, T0);
    // 第三个 key 到来：k1（最老）被驱逐，k3 自己必须留下且计数正确
    const w = s.hit('k3', 60_000, T0);
    expect(w.count).toBe(1);
    expect(s.size()).toBe(2);
    // k1 被驱逐的证据：它再 hit 时计数从 1 重新开始
    expect(s.hit('k1', 60_000, T0).count).toBe(1);
  });

  it('默认上限是 RATE_LIMIT_MAX_KEYS（防"加了配置项没人调"的静默无保护）', () => {
    expect(RATE_LIMIT_MAX_KEYS).toBeGreaterThanOrEqual(1_000);
  });
});
