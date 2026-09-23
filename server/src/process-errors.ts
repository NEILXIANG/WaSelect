/**
 * 职责：进程级错误处理（N25）——`uncaughtException` / `unhandledRejection` 的最后一道网。
 *
 * @why 这两类事件的含义是"代码漏了 catch"，出现即进程状态未定义：
 *      - 不处理：Node 默认把栈甩到 stderr 后退出（unhandledRejection 自 Node 15 起同为崩溃）。
 *        stderr 那几行**无 trace_id、无脱敏、无结构化字段**，在检索端等于隐形——
 *        而"崩溃前那一刻发生了什么"恰恰是事故复盘最需要的一行。
 *      - 只记日志不退出：进程在未知状态继续接请求，支付语境下不可接受
 *        （一个漏 catch 的写操作失败可能意味着订单状态已经不一致）。
 *      所以两件事都做：① 落一条**结构化 fatal**（走流 A 全套：脱敏、err 摊平、可检索）；
 *      ② 触发优雅停机且**退出码 1**——让平台按"异常"处理（重启 + 告警），而不是当正常退出。
 *
 * @tradeoff 对 unhandledRejection 也选择停机而不是"记了继续跑"。
 *           换来"任何漏网的失败都会被看见且不会被放大"，代价是偶发良性 rejection
 *           也会引起一次重启——本项目所有异步路径都应有显式 catch，
 *           漏了就是 bug，bug 不该被静默吞掉（与"先红后绿"同一哲学）。
 *
 * @limitation 一：处理函数本身**不能再抛**（抛了就是递归崩溃）。这里只做同步的
 *             记日志 + trigger，不 await 任何东西；logger 内部的异步写由停机流的
 *             exitDelay 兜底排空。
 * @limitation 二：只在 `bootstrap()` 成功装配后生效（见 main.ts）。装配期失败
 *             （配置错误、PG 版本不足）走 main().catch 的 stderr 路径，不在此覆盖。
 * @limitation 三：若 OS 信号停机已在进行（closing=true），trigger 会被忽略——
 *             此时 fatal 日志仍落，但退出码保持停机流原定的 0。崩溃与部署撞窗是极小概率，
 *             且日志已经留证，不值得为它破坏 closing 守卫。
 *
 * @see server/src/http.ts installShutdownHandlers（trigger 通道）、docs/代码注释规范与日志体系设计.md（流 A）
 */
import type { Logger } from './logger.js';

export interface ProcessErrorHooks {
  logger: Logger;
  /**
   * 触发优雅停机。生产实现 = `installShutdownHandlers` 返回的 `trigger`；
   * 测试注入捕获函数即可（本模块不依赖 http.ts，保持单向依赖）。
   */
  beginShutdown: (signal: string, exitCode: number) => void;
}

export interface ProcessErrorHandlers {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: Error) => void;
}

/**
 * 纯逻辑部分与"挂到 process 上"分开：处理函数导出供单测直接调用，
 * 不必向 process 真发事件（测试框架自己也监听这两个事件，真发会互相干扰）。
 */
export function makeProcessErrorHandlers(hooks: ProcessErrorHooks): ProcessErrorHandlers {
  return {
    onUnhandledRejection: (reason: unknown): void => {
      // reason 可以是任意值（reject("字符串") 是合法的），归一化为 Error 不丢信息
      hooks.logger.fatal('unhandled_rejection', {
        err: reason instanceof Error ? reason : new Error(String(reason)),
        result: 'fail',
      });
      hooks.beginShutdown('unhandledRejection', 1);
    },
    onUncaughtException: (err: Error): void => {
      hooks.logger.fatal('uncaught_exception', { err, result: 'fail' });
      hooks.beginShutdown('uncaughtException', 1);
    },
  };
}

/**
 * 挂到 process 上，返回卸载函数（测试必须卸载，否则监听器跨用例叠加）。
 * @limitation 重复调用会叠加监听器——装配层（main.ts）保证只装一次。
 */
export function installProcessErrorHandlers(hooks: ProcessErrorHooks): () => void {
  const h = makeProcessErrorHandlers(hooks);
  process.on('unhandledRejection', h.onUnhandledRejection);
  process.on('uncaughtException', h.onUncaughtException);
  return () => {
    process.off('unhandledRejection', h.onUnhandledRejection);
    process.off('uncaughtException', h.onUncaughtException);
  };
}
