/**
 * 职责：createIdFactory 的 L0 单元测试（确定性 / 唯一性 / 形状 / 边界）。
 * @see docs/测试策略与验证门禁.md §3.2、§4.2；CLAUDE.md 约束一（先红后绿，红灯证据见 F1 交付记录）
 */
import { describe, expect, it } from 'vitest';
import { createIdFactory } from './id.js';

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createIdFactory', () => {
  it('同一种子两次生成的序列完全一致（可复现）', () => {
    const a = createIdFactory(42);
    const b = createIdFactory(42);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('不同种子产生不同序列', () => {
    const a = createIdFactory(42);
    const b = createIdFactory(43);
    expect(a()).not.toEqual(b());
  });

  it('每次生成 26 位 Crockford Base32（ULID 形状）', () => {
    const f = createIdFactory(7);
    for (let i = 0; i < 50; i += 1) {
      expect(f()).toMatch(ULID_SHAPE);
    }
  });

  it('同一次运行 10000 次不重复', () => {
    const f = createIdFactory(20260922);
    const ids = new Set(Array.from({ length: 10_000 }, () => f()));
    expect(ids.size).toBe(10_000);
  });

  it('拒绝非法 seed（0 / 负数 / 小数 / NaN）', () => {
    expect(() => createIdFactory(0)).toThrow(RangeError);
    expect(() => createIdFactory(-1)).toThrow(RangeError);
    expect(() => createIdFactory(1.5)).toThrow(RangeError);
    expect(() => createIdFactory(Number.NaN)).toThrow(RangeError);
  });
});
