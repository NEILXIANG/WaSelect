/**
 * 职责：测试用的**固定时钟**（`Clock` 的一个实现）。
 *
 * @why 放在 `test/helpers/` 而不是生产适配器里：固定时钟是**测试替身**，
 *      进生产代码就等于留了一条"让系统假装是另一个时间"的路。
 *      端口只定义 `now()`，所以造一个替身只需要一行——这正是小接口的价值。
 *
 * @why 用真实 `Clock` 实现而不是 `vi.spyOn(Date, 'now')`：
 *      ② 打桩全局 Date 会**影响同进程里的所有代码**（pino 时间戳、postgres.js 心跳、
 *         调度器定时器），表现为"改了时间之后别的东西开始超时"——
 *         这类红灯与被测逻辑无关，最难排查。注入只影响拿到这个 Clock 的那条调用链。
 *      ② 反过来也说明：凡是"业务时间"都该走 Clock 端口，
 *         没走的那些（框架内部）在测试里就还是真实时间——这是可接受的，
 *         因为它们不参与业务判定。
 *
 * @limitation 每次 `now()` 返回**新的** Date：调用方若修改返回值不会污染后续调用。
 */
import type { Clock } from '../../server/src/ports/clock.js';

export function fixedClock(at: string | Date): Clock {
  const frozen = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(frozen.getTime())) {
    throw new RangeError(`fixedClock 收到非法时刻：${String(at)}`);
  }
  return { now: () => new Date(frozen.getTime()) };
}
