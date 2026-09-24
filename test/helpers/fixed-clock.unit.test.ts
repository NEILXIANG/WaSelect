/**
 * 职责：测试替身 `fixedClock` 自身的用例。
 *
 * @why 替身**也必须被测试**，否则它会成为假绿的来源：
 *      一个"把非法时刻解析成 Invalid Date 也不报错"的固定时钟，
 *      会让所有用到它的用例拿到 `NaN` 时间——
 *      表现为"边界用例莫名通过"或"报一个和被测逻辑无关的错"。
 *      排障时没人会先怀疑测试替身，所以让它在**入口**就炸。
 *
 * @limitation 只验替身的契约（固定值 / 每次新对象 / 非法输入早失败），
 *              不验业务规则——那是各被测模块自己的事。
 */
import { describe, expect, it } from 'vitest';
import { fixedClock } from './fixed-clock.js';

describe('fixedClock（测试用固定时钟）', () => {
  it('固定在同一时刻：怎么调都是同一个值', () => {
    const clock = fixedClock('2026-01-02T15:30:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-02T15:30:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-02T15:30:00.000Z');
  });

  it('接受 Date 入参（与字符串同一口径）', () => {
    const at = new Date('2026-01-02T15:30:00.000Z');
    expect(fixedClock(at).now().getTime()).toBe(at.getTime());
  });

  it('非法时刻**立刻**抛 RangeError（不静默产出 Invalid Date）', () => {
    expect(() => fixedClock('not-a-time')).toThrow(RangeError);
    expect(() => fixedClock(new Date('nope'))).toThrow(RangeError);
    // ⚠️ `new Date(undefined)` 是 Invalid Date——这类"看起来传了值"的错误最容易漏
    expect(() => fixedClock(new Date(NaN))).toThrow(RangeError);
  });

  it('每次调用返回新对象：调用方改返回值不会污染后续', () => {
    const clock = fixedClock('2026-01-02T15:30:00.000Z');
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-01-02T15:30:00.000Z');
  });
});
