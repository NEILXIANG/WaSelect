/**
 * 职责：工作单元的 L0 单测——**只验顺序**："提交之后才分发"。
 *
 * @why 这条**必须**用假的 `begin`，真库验不出来，而我第一版就是踩的这个坑：
 *      当时的写法是"订阅者用另一条连接去查事务刚写的行，看不看得到"。
 *      逻辑上成立（未提交数据对别的连接不可见），**实测是竞态**——
 *      订阅者的查询走的是一条**新建**的物理连接（`pg_backend_pid()` 实测：
 *      事务连接 34857 / 订阅者 34858），建连耗时约 10ms，而同机提交只要约 1ms，
 *      于是那条查询**总是**落在提交之后。把 `publishAll` 注回事务内，测试**全绿**。
 *      即：那条断言看起来在验顺序，实际什么都验不到（@see docs/自主决策记录.md §2 第 14 条）。
 *
 * @how 假 `begin` 把"事务"简化成三个可观测动作：`begin → 回调 → commit`，
 *      把它们的发生顺序记进数组，再与"分发"这一刻比较。
 *      顺序是**离散事件**，不受网络与建连耗时影响——这正是假实现**比真库更可靠**的地方。
 *      （真库那层只留"回滚不分发"这类不依赖时序的断言，见 unit-of-work.db.test.ts。）
 *
 * @limitation 假 `begin` 只模仿 postgres.js 的**契约形状**（预留连接 → 跑回调 → 提交），
 *              不模仿锁、隔离级别、savepoint。所以它验不了"提交真的成功了才分发"——
 *              那件事由真库的回滚用例覆盖（回滚是离散且确定的）。
 */
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { Db } from '../adapters/db.js';
import type { DomainEvent } from '../ports/events.js';
import { withUnitOfWork } from './unit-of-work.js';

/** 记录顺序用的假连接池：只实现 `begin`。 */
function fakeDb(order: string[]): Db {
  return {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('begin');
      const value = await fn('TX');
      order.push('commit');
      return value;
    },
  } as unknown as Db;
}

const ev = (orderId: string): DomainEvent => ({
  name: 'uow.happened',
  at: '2026-09-24T00:00:00.000Z',
  orderId,
});

const busWithSink = () => {
  const sink = new MemorySink();
  return { bus: createEventBus(createLogger({ env: 'development', destination: sink })), sink };
};

describe('工作单元：分发必须发生在提交之后', () => {
  it('顺序是 begin → commit → dispatch（**不是** begin → dispatch → commit）', async () => {
    const order: string[] = [];
    const { bus } = busWithSink();
    bus.subscribe('uow.happened', () => order.push('dispatch'));

    await withUnitOfWork(fakeDb(order), bus, async (_tx, emit) => {
      emit(ev('x-1'));
      return null;
    });

    expect(order).toEqual(['begin', 'commit', 'dispatch']);
  });

  it('回调执行期间**不分发**（emit 只是登记，不是发生）', async () => {
    const order: string[] = [];
    const { bus } = busWithSink();
    bus.subscribe('uow.happened', () => order.push('dispatch'));
    const inside: string[] = [];

    await withUnitOfWork(fakeDb(order), bus, async (_tx, emit) => {
      emit(ev('x-2'));
      // emit 之后同步观察：此刻不该有分发发生
      inside.push(...order);
      return null;
    });

    expect(inside).toEqual(['begin']);
    expect(order).toEqual(['begin', 'commit', 'dispatch']);
  });

  it('回调抛错（= 事务回滚）→ 不分发（顺序里根本没有 dispatch）', async () => {
    const order: string[] = [];
    const { bus } = busWithSink();
    bus.subscribe('uow.happened', () => order.push('dispatch'));

    await expect(
      withUnitOfWork(fakeDb(order), bus, async (_tx, emit) => {
        emit(ev('x-3'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(order).toEqual(['begin']); // 回调抛错 → 假 begin 直接抛出，commit 与 dispatch 都没发生
    // 真库版本见 unit-of-work.db.test.ts：抛错 = 回滚，且库里查不到写入
  });
});
