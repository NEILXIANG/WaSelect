/**
 * 职责：停机收尾（B13 / AJ-202）的单测——钉的是**顺序**与"超时要留痕"。
 *
 * @why 这两条都是"错了不报错、只错后果"的类型：
 *      ① 顺序（先 drain 后关库）反了，表现为"已取消/已过期的单在会话自然过期前还能付款"，
 *         而日志里一切正常——没有任何一行指向"停机打断了对机构的作废调用"；
 *      ② 超时不记日志，则"有订阅者被停机打断了"这件事永远没有出口，
 *         看门狗与告警都无从下手（约束八：静默失败比报错更贵）。
 *
 * @how 用**记录调用顺序**的假总线与假库：断言 `['drain', 'close']`。
 *      只断言"两个都被调了"是不够的——集合相等但顺序相反也是错的。
 */
import { describe, expect, it } from 'vitest';
import { drainEventsThenClose, EVENT_DRAIN_TIMEOUT } from './shutdown-cleanup.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { Db } from '../adapters/db.js';
import type { EventBus, DomainEvent, EventHandler } from '../ports/events.js';

/** 假总线：只记录调用，并让用例指定"drain 之后仍在途多少"。 */
function fakeBus(pending: number): { bus: EventBus; calls: string[] } {
  const calls: string[] = [];
  const bus: EventBus = {
    subscribe: (_name: string, _h: EventHandler) => () => undefined,
    publish: (_e: DomainEvent) => undefined,
    publishAll: (_es: readonly DomainEvent[]) => undefined,
    drain: async (ms: number) => {
      calls.push(`drain:${ms}`);
      return pending;
    },
  };
  return { bus, calls };
}

/** 假库：记 `end` 被调用**时的参数**（INF3-01 要断言带上了 timeout）。 */
function fakeDb(calls: string[]): Db {
  return {
    end: async (opts?: { timeout?: number }) => {
      calls.push(opts === undefined ? 'close' : `close:${JSON.stringify(opts)}`);
    },
  } as unknown as Db;
}

describe('drainEventsThenClose（B13 / AJ-202）', () => {
  it('顺序：先 drain 再关库——反了会让在途订阅者拿到"连接池已关闭"', async () => {
    const sink = new MemorySink();
    const { bus, calls } = fakeBus(0);
    await drainEventsThenClose({
      events: bus,
      db: fakeDb(calls),
      logger: createLogger({ env: 'development', destination: sink }),
      drainMs: 8_000,
    });
    expect(calls).toEqual(['drain:8000', 'close']);
    expect(sink.find(EVENT_DRAIN_TIMEOUT)).toHaveLength(0);
  });

  it('超时（仍有订阅者在途）→ 记 event_drain_timeout 并**照常关库**', async () => {
    const sink = new MemorySink();
    const { bus, calls } = fakeBus(2);
    const pending = await drainEventsThenClose({
      events: bus,
      db: fakeDb(calls),
      logger: createLogger({ env: 'development', destination: sink }),
      drainMs: 8_000,
    });
    expect(pending).toBe(2);
    // 关库**不能**因为超时被跳过：不关进程会挂住（http.ts @limitation 二）
    expect(calls).toEqual(['drain:8000', 'close']);
    const rows = sink.find(EVENT_DRAIN_TIMEOUT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ctx).toMatchObject({ pending: 2, budget_ms: 8_000 });
    expect(rows[0]?.result).toBe('timeout');
  });

  /**
   * INF3-01：`db.end()` 会等在途查询**和在途事务**跑完（实测：事务内空等 3s 时 `end()` 也等到 3s），
   * 停机路径上没有自有上限 ⇒ 最坏停机时长不可预测，且可能超过平台宽限 30s 被 SIGKILL。
   * 单位坑：postgres.js 的 `timeout` 收的是**秒**（源码 `setTimeout(destroy, timeout * 1000)`），
   * 所以 5000ms 必须传成 5——直接把 ms 传进去会变成"等 5000 秒"。
   */
  it('🔴 closeTimeoutMs 传给 db.end 且按**秒**换算（postgres.js 的 timeout 单位是秒）', async () => {
    const sink = new MemorySink();
    const { bus, calls } = fakeBus(0);
    await drainEventsThenClose({
      events: bus,
      db: fakeDb(calls),
      logger: createLogger({ env: 'development', destination: sink }),
      drainMs: 8_000,
      closeTimeoutMs: 5_000,
    });
    expect(calls).toEqual(['drain:8000', 'close:{"timeout":5}']);
  });

  it('不传 closeTimeoutMs → 不给 end 传参（旧行为：无限等；只有测试这么用）', async () => {
    const sink = new MemorySink();
    const { bus, calls } = fakeBus(0);
    await drainEventsThenClose({
      events: bus,
      db: fakeDb(calls),
      logger: createLogger({ env: 'development', destination: sink }),
      drainMs: 0,
    });
    expect(calls).toEqual(['drain:0', 'close']);
  });

  it('closeTimeoutMs 为脏值（0 / 负数 / NaN）→ 一律不给 end 传参（不把脏值换算成 1 秒）', async () => {
    const sink = new MemorySink();
    for (const bad of [0, -1, Number.NaN]) {
      const { bus, calls } = fakeBus(0);
      await drainEventsThenClose({
        events: bus,
        db: fakeDb(calls),
        logger: createLogger({ env: 'development', destination: sink }),
        drainMs: 0,
        closeTimeoutMs: bad,
      });
      expect(calls[1], String(bad)).toBe('close');
    }
  });

  it('drainMs=0 → 仍走一遍 drain（不等由总线决定，本函数不替它跳过）', async () => {
    const sink = new MemorySink();
    const { bus, calls } = fakeBus(1);
    await drainEventsThenClose({
      events: bus,
      db: fakeDb(calls),
      logger: createLogger({ env: 'development', destination: sink }),
      drainMs: 0,
    });
    expect(calls).toEqual(['drain:0', 'close']);
    expect(sink.find(EVENT_DRAIN_TIMEOUT)).toHaveLength(1);
  });
});
