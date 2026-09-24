/**
 * 职责：以**Node 真实投递形状**模拟信号，供停机相关测试使用。
 *
 * @why 这件事必须单独抽出来，有两个原因：
 *   ① Node 真实投递 OS 信号时，进程上的回调入参是**两个值** `(信号名, 信号编号)`——
 *      实测 Node 22.22 / 25.3：`process.on('SIGTERM', (...a) => …)` 收到 `['SIGTERM', 15]`。
 *      测试里若只发一个参数（`process.emit('SIGTERM', 'SIGTERM')`），
 *      就永远测不出"第二个入参顶掉默认值"这类缺陷——
 *      「正常停机退出码变成 15（平台当成异常退出）」正是这样溜过整个单测层的
 *      （2026-09-23 由产物级 e2e 抓到，见 test/e2e/dist-boot.e2e.test.ts）。
 *   ② `@types/node` 的 `process.emit` **没有**给信号事件声明额外参数重载（TS2769），
 *      所以只能经 `EventEmitter` 的宽松签名发；这一处 cast 集中在本文件，
 *      免得每个测试文件都写一遍类型逃逸。
 *
 * @limitation 只覆盖本项目会用到的信号；编号取自 Linux/macOS 的常规值（Node 实测一致），
 *              未在表中的信号会被拒绝（抛错），避免"随便填个数字"又一次失真。
 * @see server/src/http.ts（installShutdownHandlers 的注册处）
 */
import type { EventEmitter } from 'node:events';

/** 常用信号名 → 信号编号（Node 真实投递时的第二个入参）。 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGTERM: 15,
  SIGINT: 2,
  SIGHUP: 1,
  SIGQUIT: 3,
};

/**
 * 以真实形状投递信号：`(信号名, 信号编号)`。
 * @throws 未知信号名（防止测试里随手填数字，把仿真变成另一种失真）
 */
export function emitRealSignal(name: NodeJS.Signals): void {
  const code = SIGNAL_NUMBERS[name];
  if (code === undefined) {
    throw new Error(`未知信号「${name}」：先在 SIGNAL_NUMBERS 里补它的编号（Node 实测值）`);
  }
  (process as unknown as EventEmitter).emit(name, name, code);
}
