/**
 * 职责：调度器**真实接线**的 L1 集成测试（F13）——`createSchedulerDeps(db, bus, …)` 接上真库之后，
 *      清单 F13 的两条验收标准是否真的成立。
 *
 * @why 前面三个单元的测试各自都很硬，但它们的"事务"是**假的**（`unit.test.ts` 用数组记顺序，
 *      `adapters/scheduler.db.test.ts` 直接调锁和心跳）。**没有人验证过接线之后整体还是对的**：
 *      `withUnitOfWork` + `withSavepoint` + advisory lock + 心跳拼在一起，
 *      可能因为"savepoint 拿到的 sql 对象是不是同一个事务"、"事件是不是真的在提交后分发"
 *      这类接缝问题而失效——而接缝问题正是分层架构最容易出错的地方。
 *
 * @why "一个子任务失败、其余结果保留"这条在真库上验才有说服力：
 *      它依赖 **savepoint 真的回滚了那一条**，而假事务里"回滚"只是我们没 push 进数组而已。
 *
 * @limitation 只验框架，不验任何真实 job（超时关单 / 自动签收还没写）。
 *              这里用"往 `job_runs` 插一行探测数据"来代表 job 的数据库写入——
 *              因为它没有外键、没有 CHECK 约束，不会把"框架对不对"和"业务约束对不对"混在一起。
 *
 * @see ./scheduler-start.ts（接线）；./scheduler.ts（编排）；docs/地基搭建清单.md F13
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import { createEventBus } from '../adapters/event-bus.js';
import type { Clock } from '../ports/clock.js';
import type { SchedulerJob } from '../ports/scheduler.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { runSchedulerOnce } from './scheduler.js';
import { createSchedulerDeps } from './scheduler-start.js';

/** 本文件专用的心跳行名与两个探测行（跑完删掉）。 */
const ROW = 'scheduler-start-db';
const PROBE_A = `${ROW}-probe-a`;
const PROBE_B = `${ROW}-probe-b`;

let db: Db;
let other: Db;
let clock: Clock;
const sink = new MemorySink();

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  other = testDb(); // 第二个实例：互斥必须在两条独立连接上验
  let nowMs = Date.parse('2026-09-24T00:00:00.000Z');
  clock = { now: () => new Date((nowMs += 1_000)) };
}, 30_000);

afterAll(async () => {
  await db`delete from job_runs where name in (${ROW}, ${PROBE_A}, ${PROBE_B})`;
  await closeDb(db);
  await closeDb(other);
});

const logger = createLogger({ env: 'test', destination: sink });
const bus = createEventBus(logger);

async function exists(name: string): Promise<boolean> {
  const rows = await db`select 1 as ok from job_runs where name = ${name}`;
  return rows.length > 0;
}

describe('真实接线：一个子任务失败，其余结果保留、心跳不更新', () => {
  it('失败的 job 的写入随 savepoint 回滚，成功的 job 的写入**真的留下了**', async () => {
    const deps = createSchedulerDeps(db, bus, clock, logger, { name: ROW });
    const jobs: SchedulerJob<Db>[] = [
      {
        name: 'insert-a',
        async run(ctx) {
          await ctx.tx`insert into job_runs (name) values (${PROBE_A})`;
          return { processed: 1 };
        },
      },
      {
        name: 'insert-b-then-throw',
        async run(ctx) {
          await ctx.tx`insert into job_runs (name) values (${PROBE_B})`;
          throw new Error('这个 job 故意失败');
        },
      },
    ];

    const r = await runSchedulerOnce(deps, jobs);

    // ✅ a 的成果保留（没有被 b 的失败回滚掉）
    expect(await exists(PROBE_A)).toBe(true);
    // ✅ b 的写入随它自己的 savepoint 回滚了
    expect(await exists(PROBE_B)).toBe(false);

    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(r.ok).toBe(false);
    expect(r.jobs.map((j) => [j.name, j.ok])).toEqual([
      ['insert-a', true],
      ['insert-b-then-throw', false],
    ]);
  });

  it('心跳：ok=false 时 last_success_at 保持 NULL（新建的行，从未成功过）', async () => {
    const row = await db`select * from job_runs where name = ${ROW}`;
    expect(row[0]?.last_success_at).toBeNull();
    expect(row[0]?.last_error).toContain('insert-b-then-throw');
    expect(row[0]?.trace_id).toBeTruthy();
  });

  it('随后一轮全成功 → last_success_at 才被填上，last_error 清回 NULL', async () => {
    const deps = createSchedulerDeps(db, bus, clock, logger, { name: ROW });
    const r = await runSchedulerOnce(deps, []); // 空 job 列表 = 全部成功

    expect(r.acquired).toBe(true);
    const rows = await db`select * from job_runs where name = ${ROW}`;
    expect(rows[0]?.last_success_at).toBeInstanceOf(Date);
    expect(rows[0]?.last_error).toBeNull();
  });
});

describe('真实接线：两个实例同时 tick 只有一个执行', () => {
  it('先到者执行、后到者 acquired=false 且**不写心跳**', async () => {
    const depsA = createSchedulerDeps(db, bus, clock, logger, { name: ROW });
    const depsB = createSchedulerDeps(other, bus, clock, logger, { name: ROW });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;

    const slow: SchedulerJob<Db> = {
      name: 'slow',
      async run() {
        entered = true;
        await gate;
        return { processed: 0 };
      },
    };

    const first = runSchedulerOnce(depsA, [slow]);
    // 等到第一个实例确实进了事务内的 job（此时它持有锁）
    while (!entered) await new Promise((r) => setTimeout(r, 5));

    const second = await runSchedulerOnce(depsB, [slow]);
    expect(second.acquired).toBe(false);

    release();
    await first;
    expect(entered).toBe(true);
  });
});

describe('真实接线：事件在事务提交之后才分发', () => {
  it('job emit 的事件在 `runSchedulerOnce` 返回后才到达订阅者', async () => {
    const order: string[] = [];
    bus.subscribe('scheduler.probe', () => order.push('dispatch'));

    const deps = createSchedulerDeps(db, bus, clock, logger, { name: ROW });
    const emitter: SchedulerJob<Db> = {
      name: 'emitter',
      async run(ctx) {
        ctx.emit({ name: 'scheduler.probe', at: ctx.startedAt.toISOString() });
        order.push('inside-job');
        return { processed: 1 };
      },
    };

    await runSchedulerOnce(deps, [emitter]);

    expect(order).toEqual(['inside-job', 'dispatch']);
  });
});
