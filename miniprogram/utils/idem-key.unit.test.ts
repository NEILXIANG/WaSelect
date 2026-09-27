/**
 * 职责：`utils/idem-key.js` 的单测。
 *
 * @why 幂等键错了**不报错**：每次重试都换键的表现是"网络一抖建出两张单"，
 *      而用户只点了一次——服务端幂等形同虚设，且没有任何一方会报这个错。
 */
import { describe, expect, it, vi } from 'vitest';
import { newIdemKey } from './idem-key.js';

describe('newIdemKey', () => {
  it('注入固定 rand → 可复现且钉住格式（**测试不靠真随机**）', () => {
    const seq = [0.5, 0.25];
    let i = 0;
    // (0.5).toString(36) = '0.i' → slice(2) = 'i'；(0.25).toString(36) = '0.9' → '9'
    expect(newIdemKey(() => seq[i++] ?? 0)).toBe('idem-i9');
  });

  it('同一随机源两次调用相同 → 它**只**依赖注入的 rand', () => {
    expect(newIdemKey(() => 0.5)).toBe(newIdemKey(() => 0.5));
    expect(newIdemKey(() => 0.5)).not.toBe(newIdemKey(() => 0.25));
  });

  it('⚠️ 时间前进半年后产出**不变** → 幂等键里没有藏 Date.now（约束十）', () => {
    // @why 上面那条在同一毫秒内会漏：真掺了 Date.now() 也常常产出相同串。
    //      用假时钟把时间明确推到两个不同点，才能真的钉住"不取时间"。
    //      （约束十禁业务侧 new Date()；幂等键掺时间还会让"同一 rand 可复现"这件事失效。）
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const early = newIdemKey(() => 0.5);
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const later = newIdemKey(() => 0.5);
      expect(later).toBe(early);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠️ 长度在契约上限 128 内', () => {
    expect(newIdemKey().length).toBeLessThanOrEqual(128);
  });

  it('默认随机源下两次调用不相同', () => {
    expect(newIdemKey()).not.toBe(newIdemKey());
    expect(newIdemKey().startsWith('idem-')).toBe(true);
  });
});
