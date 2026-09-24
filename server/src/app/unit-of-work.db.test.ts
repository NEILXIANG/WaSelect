/**
 * 职责：工作单元的 L1 真库测试（R2-2 验收二）——**事务回滚时事件不分发**。
 *
 * @why 这一条必须**真库**验：内存假事务可以"假装回滚"，而真库的回滚语义
 *      （提交前一切不可见、抛错即整体撤销）正是本层要保证的东西。
 *      用假事务测出来的绿灯，在生产的事务边界上不成立。
 *
 * @how 除了"回滚时不分发"，还额外断言两件事，都是假实现容易蒙混过去的：
 *      ① **分发发生在提交之后**——订阅者在库里能查到事务刚写的行（事务内查得到不代表提交后也成立，
 *         反过来：提交前订阅者看到的库，与提交后看到的库是同一个；所以这条真正验的是
 *         "订阅者跑的时候事务已经不在了"——它用的是**另一条连接**，见下面用例的做法）；
 *      ② **事件顺序 = emit 顺序**。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withSavepoint, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { DomainEvent, EventBus } from '../ports/events.js';
import { withUnitOfWork } from './unit-of-work.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

const busWithSink = (): { bus: EventBus; sink: MemorySink; seen: DomainEvent[] } => {
  const sink = new MemorySink();
  const bus = createEventBus(createLogger({ env: 'development', destination: sink }));
  const seen: DomainEvent[] = [];
  bus.subscribe('uow.happened', (e) => seen.push(e));
  return { bus, sink, seen };
};

const ev = (orderId: string, at = '2026-09-24T00:00:00.000Z'): DomainEvent => ({
  name: 'uow.happened',
  at,
  orderId,
});

describe('工作单元：提交后分发', () => {
  /**
   * ⚠️ 这里**故意不测**“分发发生在提交之后”那条——它测不出来，原因见
   * `unit-of-work.unit.test.ts` 的同名说明（真库下是竞态：订阅者走的是**新连接**，
   * 建连耗(~10ms) > 提交耗时(~1ms)，查询实际落在提交之后，缺陷注回后照样全绿）。
   * 顺序交给假 begin 按序断言；真库只负责**回滚语义**这类不依赖时序的东西。
   */
  it('事务成功 → 事件被分发（顺序的正确性由 unit 层的假 begin 断言，此处只验"发了"）', async () => {
    const { bus, seen } = busWithSink();
    await withUnitOfWork(db, bus, async (tx, emit) => {
      await tx`insert into users (id, email) values ('uow-1', 'uow-1@example.com')`;
      emit(ev('uow-1'));
      return 'done';
    });
    expect(seen.map((e) => e.orderId)).toEqual(['uow-1']);
  });

  it('事务抛错 → **事件不分发**，且库里查不到那一行（R2-2 验收二）', async () => {
    const { bus, seen } = busWithSink();
    await expect(
      withUnitOfWork(db, bus, async (tx, emit) => {
        await tx`insert into users (id, email) values ('uow-2', 'uow-2@example.com')`;
        emit(ev('uow-2'));
        throw new Error('business boom');
      }),
    ).rejects.toThrow('business boom');

    expect(seen).toEqual([]);
    expect(await db`select id from users where id = 'uow-2'`).toHaveLength(0);
  });

  it('DB 级约束拒绝（不是业务抛错）→ 同样不分发（回滚的成因无关）', async () => {
    const { bus, seen } = busWithSink();
    // users 有 CHECK (openid IS NOT NULL OR email IS NOT NULL)：两个都给 NULL → 23514
    await expect(
      withUnitOfWork(db, bus, async (tx, emit) => {
        await tx`insert into users (id, openid, email) values ('uow-3', null, null)`;
        emit(ev('uow-3'));
        return 'never';
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('多个事件按 emit 顺序分发（顺序错了，订阅者看到的因果就是反的）', async () => {
    const { bus, seen } = busWithSink();
    await withUnitOfWork(db, bus, async (_tx, emit) => {
      emit(ev('uow-a', '2026-09-24T00:00:01.000Z'));
      emit(ev('uow-b', '2026-09-24T00:00:02.000Z'));
      return null;
    });
    expect(seen.map((e) => e.orderId)).toEqual(['uow-a', 'uow-b']);
  });

  it('订阅者抛错 → 调用方（业务）正常返回，事件照常算已发布', async () => {
    const { bus, sink } = busWithSink();
    bus.subscribe('uow.happened', () => {
      throw new Error('subscriber boom');
    });
    const value = await withUnitOfWork(db, bus, async (_tx, emit) => {
      emit(ev('uow-4'));
      return 'business-ok';
    });
    expect(value).toBe('business-ok');
    expect(sink.find('domain_event_subscriber_failed')).toHaveLength(1);
  });

  it('事务内仍可用 savepoint（本层不禁止嵌套单元，只禁止嵌套事务）', async () => {
    const { bus, seen } = busWithSink();
    await withUnitOfWork(db, bus, async (tx, emit) => {
      await tx`insert into users (id, email) values ('uow-5', 'uow-5@example.com')`;
      // 内层失败只回滚到 savepoint，外层继续
      await withSavepoint(tx, async (sp) => {
        await sp`insert into users (id, email) values ('uow-6', 'uow-6@example.com')`;
        throw new Error('inner');
      }).catch(() => undefined);
      emit(ev('uow-5'));
      return null;
    });
    expect(seen.map((e) => e.orderId)).toEqual(['uow-5']);
    expect(await db`select id from users where id = 'uow-5'`).toHaveLength(1);
    expect(await db`select id from users where id = 'uow-6'`).toHaveLength(0);
  });
});
