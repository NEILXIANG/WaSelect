/**
 * 职责：时钟的**真实实现**（F10）——桥到运行时的系统时间。
 *
 * @why 放在 `adapters/`：系统时间是进程之外的东西（OS / 宿主），
 *      和数据库、支付机构一样属于"边界"。业务与 domain 只见 `ports/clock.ts` 的 `Clock`，
 *      换实现（比如将来接 NTP 偏移校正、或在测试里换固定时钟）只动这一处。
 *
 * @limitation 一：**不做**固定时钟 / 假时钟。测试要固定时间就自己实现 `Clock`
 *              （`test/helpers/fixed-clock.ts`）——把测试替身放进生产适配器，
 *              等于在生产代码里留一条"可以骗过时间"的路，迟早有人在生产里调到。
 * @limitation 二：不做单调时钟（`performance.now()`）。本端口回答的是"现在是什么时候"，
 *              不是"过了多久"——耗时统计走 `Date.now()` 差值或 `performance.now()`，
 *              两者混用会让"用户看到的到期时间"被系统时钟调整（NTP 校时）带着漂。
 *
 * @see ../ports/clock.ts（契约与全部设计理由）
 */
import type { Clock } from '../ports/clock.js';

/** 系统时钟：装配处注入生产用。每次返回**新的** Date 对象（见 ports 的 @limitation 二）。 */
export const systemClock: Clock = {
  now: () => new Date(),
};
