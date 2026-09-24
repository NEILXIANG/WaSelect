/**
 * 职责：进程级错误处理（N25）的 L0 单测。
 *
 * @why uncaughtException / unhandledRejection 是"代码漏了 catch"的最后一道网：
 *      没有它，Node 默认的崩溃栈只进 stderr——无 trace_id、无脱敏、无结构化字段，
 *      在检索端等于隐形；更糟的是进程状态未定义时还在接请求。
 *      这里断言两件事：① 崩溃一定落成一条**结构化 fatal**（可检索、带 err）；
 *      ② 随后触发优雅停机且退出码非 0（让平台按"异常"而非"正常退出"处理）。
 *
 * 测试不向 process 真发事件（vitest 自己也监听这两个事件，会互相干扰），
 * 直接调用 makeProcessErrorHandlers 返回的处理函数；接线本身用 listenerCount 断言。
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { installProcessErrorHandlers, makeProcessErrorHandlers } from './process-errors.js';
import { MemorySink } from '../../test/helpers/memory-sink.js';

function setup() {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  const calls: Array<{ signal: string; code: number }> = [];
  const hooks = {
    logger,
    beginShutdown: (signal: string, code: number) => {
      calls.push({ signal, code });
    },
  };
  return { sink, hooks, calls };
}

describe('进程级错误处理（N25）', () => {
  it('uncaughtException：结构化 fatal 落日志（带 err），随后以退出码 1 触发优雅停机', () => {
    const { sink, hooks, calls } = setup();
    const h = makeProcessErrorHandlers(hooks);
    const boom = new Error('db driver exploded');
    h.onUncaughtException(boom);

    const rows = sink.find('uncaught_exception');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe('fatal');
    // err 字段经 redact 摊平为 { err_type, err_message }（见 logger「Error 作为字段被摊平」）
    expect(rows[0]?.err).toMatchObject({ err_type: 'Error', err_message: 'db driver exploded' });
    expect(calls).toEqual([{ signal: 'uncaughtException', code: 1 }]);
  });

  it('unhandledRejection（Error reason）：同样 fatal + 停机', () => {
    const { sink, hooks, calls } = setup();
    const h = makeProcessErrorHandlers(hooks);
    h.onUnhandledRejection(new Error('charge write failed silently'));

    const rows = sink.find('unhandled_rejection');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe('fatal');
    expect(calls).toEqual([{ signal: 'unhandledRejection', code: 1 }]);
  });

  it('unhandledRejection（非 Error reason，如 reject("字符串")）：归一化为 Error，不丢信息', () => {
    const { sink, hooks, calls } = setup();
    const h = makeProcessErrorHandlers(hooks);
    h.onUnhandledRejection('plain string reason');

    const rows = sink.find('unhandled_rejection');
    expect(rows[0]?.err).toMatchObject({ err_type: 'Error', err_message: 'plain string reason' });
    expect(calls).toEqual([{ signal: 'unhandledRejection', code: 1 }]);
  });

  it('install/uninstall：真实挂载到 process 且可卸载（防测试间叠加监听器）', () => {
    const { hooks } = setup();
    const beforeRej = process.listenerCount('unhandledRejection');
    const beforeExc = process.listenerCount('uncaughtException');
    const uninstall = installProcessErrorHandlers(hooks);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRej + 1);
    expect(process.listenerCount('uncaughtException')).toBe(beforeExc + 1);
    uninstall();
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRej);
    expect(process.listenerCount('uncaughtException')).toBe(beforeExc);
  });
});
