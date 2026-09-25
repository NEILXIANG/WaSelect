/**
 * 职责：调度器的 L1 真库测试（F13）——**互斥**与**心跳语义**。
 *
 * @why 这两件事**必须**用真库验，而且互斥**只能**用真库验：
 *      ① advisory lock 是 PG 的运行时行为（事务级、随提交释放），任何假库都模仿不了；
 *      ② "两个实例同时 tick 只有一个执行"在单进程里根本无法制造——
 *         同一个进程里连开两个事务拿同一把锁，PG 的行为和跨进程一模一样，
 *         但**如果**将来有人把锁实现换成"进程内 Set"，这条用例依然会红（因为用的是两个连接池）。
 * @why 心跳那三条断言（失败不动 `last_success_at`、成功清空 `last_error`、trace_id 落库）
 *      看似简单，却是**看门狗失明与否**的全部：判反了不报错，只表现为
 *      "某 job 连续失败一天，监控却显示刚刚还成功过"。
 *
 * @limitation `resetTestDb` **刻意不清** `job_runs`（它在 truncate 白名单里，见 test-db.ts），
 *              所以本文件用**自己的**行名并在跑完后删掉；另有一条例外：
 *              断言 seeded 的 'tick' 行存在（D-45），那条只读不写。
 *
 * @see ../ports/scheduler.ts（三条口径）；./scheduler.ts（SQL）；docs/自主决策记录.md AJ-57
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTransaction, type Db } from './db.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import { TICK_JOB_NAME, TICK_LOCK_KEY } from '../ports/scheduler.js';
import { createJobRunLog, createSchedulerLock } from './scheduler.js';

/** 本文件专用的行名：跑完删掉，不污染 seed。 */
const ROW = 'scheduler-db-test';

let db: Db;
let other: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  // 第二个连接池 = 第二个实例：互斥用例必须跨连接才有意义（见文件头 @why）
  other = testDb();
}, 30_000);

afterAll(async () => {
  // 先删自己的行，再关连接（顺序反了会留下垃圾行影响后续文件）
  await db`delete from job_runs where name = ${ROW}`;
  await closeDb(db);
  await closeDb(other);
});

const lock = createSchedulerLock();
const runs = createJobRunLog();

async function readRow(name: string): Promise<Record<string, unknown> | undefined> {
  const rows = await db`select * from job_runs where name = ${name}`;
  return rows[0] as Record<string, unknown> | undefined;
}

describe('互斥：两个实例同时 tick', () => {
  it('先到者拿到锁，**后到者拿到 false**（不是排队等）', async () => {
    await withTransaction(db, async (txA) => {
      expect(await lock.tryAcquire(txA, TICK_LOCK_KEY)).toBe(true);

      await withTransaction(other, async (txB) => {
        expect(await lock.tryAcquire(txB, TICK_LOCK_KEY)).toBe(false);
      });
    });
  });

  it('持有者**提交**后锁自动释放（没有任何"解锁"代码——这正是选事务级锁的理由）', async () => {
    await withTransaction(db, async (txA) => {
      expect(await lock.tryAcquire(txA, TICK_LOCK_KEY)).toBe(true);
    });
    await withTransaction(other, async (txB) => {
      expect(await lock.tryAcquire(txB, TICK_LOCK_KEY)).toBe(true);
    });
  });

  it('持有者**回滚**后锁同样释放（进程崩溃路径：不会留下没人认领的锁）', async () => {
    await expect(
      withTransaction(db, async (txA) => {
        expect(await lock.tryAcquire(txA, TICK_LOCK_KEY)).toBe(true);
        throw new Error('模拟崩溃');
      }),
    ).rejects.toThrow('模拟崩溃');

    await withTransaction(other, async (txB) => {
      expect(await lock.tryAcquire(txB, TICK_LOCK_KEY)).toBe(true);
    });
  });

  it('不同 key 之间**不互斥**（两个定时任务可以并行）', async () => {
    await withTransaction(db, async (txA) => {
      expect(await lock.tryAcquire(txA, TICK_LOCK_KEY)).toBe(true);
      await withTransaction(other, async (txB) => {
        expect(await lock.tryAcquire(txB, 'scheduler:daily')).toBe(true);
      });
    });
  });
});

describe('job_runs 心跳', () => {
  it('迁移 seed 了 tick 与 daily（D-45：没有行 → UPDATE 影响 0 行 → 心跳静默消失）', async () => {
    const tick = await readRow(TICK_JOB_NAME);
    const daily = await readRow('daily');
    expect(tick).toBeDefined();
    expect(daily).toBeDefined();
  });

  it('成功：更新 last_success_at、清空 last_error、写入 trace_id', async () => {
    const at = new Date('2026-09-24T01:00:00.000Z');
    await withTransaction(db, async (tx) => {
      await runs.record(tx, { name: ROW, ok: true, traceId: 'tr-1', at });
    });
    const row = await readRow(ROW);
    expect(row?.trace_id).toBe('tr-1');
    expect(row?.last_error).toBeNull();
    expect(String(row?.last_success_at)).toBe(String(at));
    expect(String(row?.updated_at)).toBe(String(at));
  });

  it('失败：**last_success_at 一动不动**，只写 last_error（看门狗全靠这一条）', async () => {
    const firstAt = new Date('2026-09-24T01:00:00.000Z');
    const failAt = new Date('2026-09-24T02:00:00.000Z'); // 一小时后失败
    await withTransaction(db, async (tx) => {
      await runs.record(tx, { name: ROW, ok: true, traceId: 'tr-1', at: firstAt });
    });
    await withTransaction(db, async (tx) => {
      await runs.record(tx, {
        name: ROW,
        ok: false,
        error: '1/2 个子任务失败 → b: 超时',
        at: failAt,
      });
    });

    const row = await readRow(ROW);
    expect(row?.last_success_at).toBeInstanceOf(Date);
    expect(String(row?.last_success_at)).toBe(String(firstAt)); // ← 没被推进
    expect(row?.last_error).toBe('1/2 个子任务失败 → b: 超时');
    expect(String(row?.updated_at)).toBe(String(failAt)); // updated_at 仍要动（否则看不出"还在跑"）
  });

  it('失败后再次成功：last_error 被清回 NULL（不留着上一次的错误吓人）', async () => {
    await withTransaction(db, async (tx) => {
      await runs.record(tx, { name: ROW, ok: false, error: 'boom', at: new Date() });
    });
    await withTransaction(db, async (tx) => {
      await runs.record(tx, { name: ROW, ok: true, at: new Date('2026-09-24T03:00:00.000Z') });
    });
    const row = await readRow(ROW);
    expect(row?.last_error).toBeNull();
    expect(String(row?.last_success_at)).toBe(String(new Date('2026-09-24T03:00:00.000Z')));
  });

  it('行不存在时 upsert 也能建出来（不依赖 seed 是否齐全）', async () => {
    const fresh = `${ROW}-fresh`;
    await withTransaction(db, async (tx) => {
      await runs.record(tx, { name: fresh, ok: true, traceId: 'tr-9', at: new Date() });
    });
    const row = await readRow(fresh);
    expect(row?.trace_id).toBe('tr-9');
    await db`delete from job_runs where name = ${fresh}`;
  });
});
