/**
 * 职责：一轮 tick 编排的 L0 单测——**只验顺序与边界**，不碰数据库。
 *
 * @why 这里要钉的是三条**错了也不报错**的性质：
 *      ① 没抢到锁时必须**什么都不做**（不跑 job、不写心跳、不分发事件）——
 *         否则"两个实例各跑一遍"会以"日志翻倍"的形式出现，而没人会去查为什么；
 *      ② 一个子任务失败，其余子任务的成果**必须保留**（各自 savepoint）；
 *      ③ job 在**抛错之前** emit 的事件**绝不能**被分发——
 *         它的数据库写入已经随 savepoint 回滚了，事件却发出去 = 幽灵副作用。
 *      这三条在真库上都很难稳定复现（要制造并发与精确的失败时机），假事务反而更可靠
 *      （与 `unit-of-work.unit.test.ts` 的取舍同源：顺序是**离散事件**，不受耗时影响）。
 *
 * @how `TTx` 取 `string`——编排层对事务句柄的形状没有任何要求，用字符串当句柄
 *      正好能证明"它没有偷偷用到 `Db` 的任何能力"。
 */
import { describe, expect, it } from 'vitest';
import type { Clock } from '../ports/clock.js';
import type { DomainEvent } from '../ports/events.js';
import {
  TICK_JOB_NAME,
  TICK_LOCK_KEY,
  type JobOutcome,
  type JobRunRecord,
  type SchedulerJob,
} from '../ports/scheduler.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { Emit } from './unit-of-work.js';
import { runSchedulerOnce, type SchedulerDeps } from './scheduler.js';

const BASE = Date.parse('2026-09-24T00:00:00.000Z');

/** 假事务句柄（编排层不该关心它是什么）。 */
type Tx = string;

interface Harness {
  deps: SchedulerDeps<Tx>;
  /** 离散事件顺序：begin / sp:<job> / commit / dispatch:<event> */
  order: string[];
  dispatched: DomainEvent[];
  /** 每次心跳一行 */
  runs: JobRunRecord[];
  /** 手动推进注入的时钟（ms），让 duration_ms 可断言 */
  advance(ms: number): void;
  setAcquired(v: boolean): void;
  /** 本轮打出的日志行（AJ-320：用来断言 tick 汇总按 job 名分别给数字）。 */
  sink: MemorySink;
}

function harness(opts: { acquired?: boolean } = {}): Harness {
  const order: string[] = [];
  const dispatched: DomainEvent[] = [];
  const runs: JobRunRecord[] = [];
  let acquired = opts.acquired ?? true;
  let nowMs = BASE;

  const clock: Clock = { now: () => new Date(nowMs) };
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });

  const deps: SchedulerDeps<Tx> = {
    clock,
    logger,
    // 形状与真 `withUnitOfWork` 一致：begin → 回调 → commit → 分发
    unitOfWork: async (fn) => {
      order.push('begin');
      const collected: DomainEvent[] = [];
      const emit: Emit = (e) => collected.push(e);
      const value = await fn('TX', emit);
      order.push('commit');
      for (const e of collected) {
        order.push(`dispatch:${String(e.name)}`);
        dispatched.push(e);
      }
      return value;
    },
    savepoint: async (_tx, fn) => {
      return fn('SP');
    },
    lock: {
      async tryAcquire(tx, key) {
        order.push(`lock:${String(tx)}:${key}`);
        return acquired;
      },
    },
    runs: {
      async record(_tx, input) {
        runs.push(input);
      },
    },
  };

  return {
    deps,
    order,
    dispatched,
    runs,
    advance: (ms) => {
      nowMs += ms;
    },
    setAcquired: (v) => {
      acquired = v;
    },
    sink,
  };
}

/** 一个会 emit、并可选抛错的 job。 */
function job(
  name: string,
  opts: { emit?: string; throwAfterEmit?: boolean; processed?: number } = {},
): SchedulerJob<Tx> {
  return {
    name,
    async run(ctx) {
      if (opts.emit !== undefined) {
        ctx.emit({ name: opts.emit, at: ctx.startedAt.toISOString() });
      }
      if (opts.throwAfterEmit === true) throw new Error(`${name} 炸了`);
      return { processed: opts.processed ?? 1 } satisfies JobOutcome;
    },
  };
}

describe('没抢到锁：本轮什么都不做', () => {
  it('不跑任何 job、不写心跳、不分发事件（**不是失败**，是"别人在做"）', async () => {
    const h = harness({ acquired: false });
    let ran = 0;
    const spy: SchedulerJob<Tx> = {
      name: 'spy',
      async run() {
        ran += 1;
        return { processed: 0 };
      },
    };

    const r = await runSchedulerOnce(h.deps, [spy]);

    expect(r.acquired).toBe(false);
    expect(ran).toBe(0);
    expect(h.runs).toHaveLength(0);
    expect(h.dispatched).toHaveLength(0);
    // 仍然开了事务（锁必须在事务里取），但事务里只有取锁这一件事
    expect(h.order).toEqual(['begin', `lock:TX:${TICK_LOCK_KEY}`, 'commit']);
  });

  it('返回类型上没有 ok 字段（判别联合逼调用方先判 acquired）', async () => {
    const h = harness({ acquired: false });
    const r = await runSchedulerOnce(h.deps, []);
    expect('ok' in r).toBe(false);
    expect('jobs' in r).toBe(false);
  });
});

describe('抢到锁：顺序执行 + 各自 savepoint', () => {
  it('**串行**执行：后一个 job 必须等前一个**跑完**才开始（不是"同时开始、先后结束"）', async () => {
    const h = harness();
    const seen: string[] = [];
    const mk = (name: string): SchedulerJob<Tx> => ({
      name,
      async run(ctx) {
        seen.push(`${name}:start:${ctx.tx}`);
        await Promise.resolve(); // 让出一次：并发与串行在这里才会分岔
        seen.push(`${name}:end`);
        return { processed: 1 };
      },
    });

    const r = await runSchedulerOnce(h.deps, [mk('a'), mk('b'), mk('c')]);

    // 串行的形状是 a 开始→a 结束→b 开始；并发会得到 a/b/c 三个 start 连在一起
    expect(seen).toEqual(['a:start:SP', 'a:end', 'b:start:SP', 'b:end', 'c:start:SP', 'c:end']);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(r.ok).toBe(true);
  });

  it('一个子任务失败 → **其余照常执行且成果保留**，心跳 ok=false 但照写', async () => {
    const h = harness();
    const r = await runSchedulerOnce(h.deps, [
      job('a'),
      job('b', { throwAfterEmit: true }),
      job('c'),
    ]);

    if (!r.acquired) throw new Error('应当抢到锁');
    expect(r.ok).toBe(false);
    expect(r.jobs.map((j) => [j.name, j.ok])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
    // ✅ c 的成果保留（b 失败没有回滚掉 a / c）
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ name: TICK_JOB_NAME, ok: false });
    expect(h.runs[0]?.error).toContain('b: b 炸了');
    expect(h.runs[0]?.error).toContain('1/3');
  });

  it('全成功 → 心跳 ok=true、error 为 undefined（会把 last_error 清回 NULL）', async () => {
    const h = harness();
    await runSchedulerOnce(h.deps, [job('a'), job('b')]);
    expect(h.runs[0]).toMatchObject({ name: TICK_JOB_NAME, ok: true });
    expect(h.runs[0]?.error).toBeUndefined();
  });

  /**
   * AJ-320：`scheduler_tick_done` 此前只给一个**跨 job 求和**的数字，而
   * `ports/scheduler.ts` @limitation 二 明确要求"日志里必须带上 job 名"——
   * 关单的"关了几单"与看门狗的"0/1 停跑标志"混成一个数之后，日志也读不出是谁贡献的。
   * 现在按 job 名分别给：这是"012 想要的那件事"今天真正落地的那一半。
   */
  it('tick 汇总日志**按 job 名**分别给 processed（不是只给一个求和值，AJ-320）', async () => {
    const h = harness();
    await runSchedulerOnce(h.deps, [
      job('expire_orders', { processed: 3 }),
      job('cleanup_idempotency', { processed: 5 }),
    ]);
    const rows = h.sink.rows().filter((r) => r.event === 'scheduler_tick_done');
    expect(rows).toHaveLength(1);
    const byJob = rows[0]?.['processed_by_job'];
    expect(byJob).toEqual([
      { job: 'expire_orders', processed: 3 },
      { job: 'cleanup_idempotency', processed: 5 },
    ]);
  });
});

describe('外部动作：事务提交之后才分发', () => {
  it('顺序是 begin → … → commit → dispatch（不是 begin → dispatch → commit）', async () => {
    const h = harness();
    await runSchedulerOnce(h.deps, [job('a', { emit: 'order.expired' })]);
    expect(h.order).toEqual([
      'begin',
      `lock:TX:${TICK_LOCK_KEY}`,
      'commit',
      'dispatch:order.expired',
    ]);
  });

  it('**失败 job 在抛错前 emit 的事件绝不分发**（savepoint 已回滚，事件却发出去 = 幽灵副作用）', async () => {
    const h = harness();
    await runSchedulerOnce(h.deps, [job('bad', { emit: 'order.expired', throwAfterEmit: true })]);

    expect(h.dispatched).toHaveLength(0);
    expect(h.order).not.toContain('dispatch:order.expired');
    // 但事务本身照常提交（其余 job 的成果要保留）
    expect(h.order).toContain('commit');
    expect(h.runs[0]?.ok).toBe(false);
  });

  it('同一轮里：失败 job 的事件丢弃、成功 job 的事件照发', async () => {
    const h = harness();
    await runSchedulerOnce(h.deps, [
      job('bad', { emit: 'ghost', throwAfterEmit: true }),
      job('good', { emit: 'real' }),
    ]);

    expect(h.dispatched.map((e) => e.name)).toEqual(['real']);
  });
});

describe('一轮一个 trace_id 与统一 startedAt', () => {
  it('同一轮里所有 job 看到**同一个** startedAt（不是各自取一次 now）', async () => {
    const h = harness();
    const seen: string[] = [];
    const mk = (name: string): SchedulerJob<Tx> => ({
      name,
      async run(ctx) {
        h.advance(1_000); // job 跑得很"久"
        seen.push(ctx.startedAt.toISOString());
        return { processed: 1 };
      },
    });

    await runSchedulerOnce(h.deps, [mk('a'), mk('b')]);

    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(new Date(BASE).toISOString());
  });

  it('trace_id 同时出现在返回值与心跳行里（从心跳能反查这一轮日志）', async () => {
    const h = harness();
    const r = await runSchedulerOnce(h.deps, [job('a')]);
    expect(r.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.runs[0]?.traceId).toBe(r.traceId);
  });

  it('durationMs 反映注入时钟的推进（不是真实耗时）', async () => {
    const h = harness();
    const slow: SchedulerJob<Tx> = {
      name: 'slow',
      async run() {
        h.advance(4_000);
        return { processed: 1 };
      },
    };
    const r = await runSchedulerOnce(h.deps, [slow]);
    expect(r.durationMs).toBe(4_000);
    expect(r.acquired).toBe(true); // 没拿到锁时下面整段静默跳过（审查 2026-10-09 C8）
    if (!r.acquired) return;
    expect(r.jobs[0]).toMatchObject({ name: 'slow', ok: true, durationMs: 4_000 });
  });
});

describe('可复用于别的定时任务（daily 对账走同一个编排）', () => {
  it('自定义 name / lockKey 会被当真（不是写死的 tick）', async () => {
    const h = harness();
    const r = await runSchedulerOnce({ ...h.deps, name: 'daily', lockKey: 'scheduler:daily' }, [
      job('reconcile'),
    ]);

    expect(h.order).toContain('lock:TX:scheduler:daily');
    expect(h.runs[0]?.name).toBe('daily');
    expect(r.acquired).toBe(true);
  });
});

describe('job 拿到的日志器', () => {
  it('四个级别都自动带上 job 字段，且**不允许被调用方的 fields 覆盖**', async () => {
    const h = harness();
    const sink = new MemorySink();
    const deps: SchedulerDeps<Tx> = {
      ...h.deps,
      logger: createLogger({ env: 'test', destination: sink }),
    };
    const loggerJob: SchedulerJob<Tx> = {
      name: 'close-expired',
      async run(ctx) {
        // 每一级都刻意传一个伪造的 job：它必须赢不了
        ctx.log.debug('j_debug', { job: '伪造的名字' });
        ctx.log.info('j_info', { job: '伪造的名字', processed: 3 });
        ctx.log.warn('j_warn', { job: '伪造的名字' });
        ctx.log.error('j_error', { job: '伪造的名字' });
        return { processed: 3 };
      },
    };

    await runSchedulerOnce(deps, [loggerJob]);

    for (const event of ['j_debug', 'j_info', 'j_warn', 'j_error']) {
      const row = sink.find(event)[0];
      expect(row, `缺少 ${event} 的日志`).toBeDefined();
      expect(row?.job).toBe('close-expired'); // ← 覆盖不掉
      expect(row?.module).toBe('scheduler');
      expect(row?.actor).toBe('scheduler');
    }
  });

  it('失败时记 error 日志，且 err_message 走的是**归一化后**的文本（不是原始多行报错）', async () => {
    const h = harness();
    const sink = new MemorySink();
    const deps: SchedulerDeps<Tx> = {
      ...h.deps,
      logger: createLogger({ env: 'test', destination: sink }),
    };
    const boom: SchedulerJob<Tx> = {
      name: 'boom',
      async run() {
        throw new Error('第一行\n第二行');
      },
    };

    await runSchedulerOnce(deps, [boom]);

    const row = sink.find('scheduler_job_failed')[0];
    expect(row?.job).toBe('boom');
    expect(row?.err_message).toBe('第一行 第二行'); // 换行已折叠
  });
});
