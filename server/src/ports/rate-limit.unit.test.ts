/**
 * 职责：限流端口纯函数的 L0 用例（I1-U3）——窗口对齐、放行边界、Retry-After 下限。
 * @see ports/rate-limit.ts（被测）
 */
import { describe, expect, it } from 'vitest';
import { isAllowed, retryAfterSecOf, windowStartOf } from './rate-limit.js';

describe('windowStartOf：时钟对齐', () => {
  it('同一分钟内的任意时刻落在同一窗口', () => {
    const base = Date.parse('2026-01-02T12:00:00.000Z');
    expect(windowStartOf(base, 60_000)).toBe(base);
    expect(windowStartOf(base + 37_000, 60_000)).toBe(base);
    expect(windowStartOf(base + 59_999, 60_000)).toBe(base);
    expect(windowStartOf(base + 60_000, 60_000)).toBe(base + 60_000);
  });
});

describe('isAllowed：第 limit 次放行，第 limit+1 次拒绝', () => {
  const w = (count: number) => ({ count, resetAtMs: 60_000 });
  it('边界两侧', () => {
    expect(isAllowed(w(29), 30)).toBe(true);
    expect(isAllowed(w(30), 30)).toBe(true);
    expect(isAllowed(w(31), 30)).toBe(false);
  });
});

describe('retryAfterSecOf：至少 1 秒', () => {
  it('窗口剩余 500ms → 1 秒（不许回 0 让客户端立即重试）', () => {
    expect(retryAfterSecOf({ count: 31, resetAtMs: 1_500 }, 1_000)).toBe(1);
  });
  it('窗口剩余 30 秒 → 30 秒', () => {
    expect(retryAfterSecOf({ count: 31, resetAtMs: 60_000 }, 30_000)).toBe(30);
  });
});
