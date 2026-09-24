/**
 * 职责：真实时钟适配器（`systemClock`）的用例。
 *
 * @why 这个实现只有一行，但有两件事必须在**每次跑**时被钉住：
 *      ① 它必须真的接系统时间（有人把它改成固定值时，"时间"这个概念就假了，
 *         而假时间在生产上表现为"订单永不过期"，症状离原因极远）；
 *      ② `now()` 必须每次返回**新对象**（ports/clock.ts @limitation 二）。
 *         返回一个共享实例时，任何调用方的一次就地修改都会污染全进程后续的时间。
 *
 * @limitation 不断言"等于某个具体时刻"（那需要冻结时间，本端口刻意不做），
 *              只断言"贴着真实时间走"——误差窗口给到 1 秒，足够宽松到不抖动，
 *              又足够紧到能抓出"返回了一个固定值"。
 */
import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';

describe('systemClock（真实时钟适配器）', () => {
  it('返回合法的 Date，且贴着真实系统时间（±1s）', () => {
    const before = Date.now();
    const at = systemClock.now();
    expect(at).toBeInstanceOf(Date);
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(Math.abs(at.getTime() - before)).toBeLessThan(1_000);
  });

  it('每次调用返回**不同的对象**（共享可变实例会污染后续调用）', () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(a).not.toBe(b);
    // 改 a 不影响 b：这就是"每次新建"这条约定要防的事故
    const bIso = b.toISOString();
    a.setUTCFullYear(1999);
    expect(b.toISOString()).toBe(bIso);
  });

  it('时间不倒退（第二次调用 ≥ 第一次）', () => {
    // @why 单调性是"到期判断"的前提：时钟往回跳一次，
    //      `expires_at < now()` 就会对一批已经该关的单判定为"还没到"。
    //      系统时钟本身可能被 NTP 回调，所以只断言**不倒退**这一条最弱的性质，
    //      且用两次紧邻调用（NTP 校时在毫秒级窗口内不会插进来）。
    const first = systemClock.now().getTime();
    const second = systemClock.now().getTime();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
