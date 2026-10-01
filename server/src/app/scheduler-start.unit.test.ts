/**
 * 职责：常驻调度器的 L0 单测——**只验定时器行为与容错**，不碰数据库。
 *
 * @why 这一层最该防的是两件"不会报错、只会让事情悄悄变糟"的事：
 *      ① **同一进程内两轮重叠**：setInterval 不关心上一轮跑完没有，
 *         60s 间隔 + 一轮跑 90s 时，第二轮会再开一个事务去抢同一把锁——
 *         数据库层不会错（拿不到锁就跳过），但白白消耗一条连接与一轮心跳判定，
 *         而且"跳过"与"抢到"在日志里长得一样，排查时会被误导。
 *      ② **一轮抛错没人管**：`setInterval` 的回调里抛出的 rejection 没有任何人接，
 *         直接变成 `unhandledRejection`——在 Node 默认配置下**整个进程退出**。
 *         即"某个 job 抛了一次异常"会导致服务重启，而日志上只看到进程没了。
 *
 * @how 用 vitest 假定时器推进时间，`runSchedulerOnce` 那一层用假的注入
 *      （与 `scheduler.unit.test.ts` 同一套做法：顺序与容错是离散事件，不受真实耗时影响）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../ports/clock.js';
import type { Db } from '../adapters/db.js';
import type { DomainEvent, EventBus } from '../ports/events.js';
import { TICK_JOB_NAME, type SchedulerJob, type SchedulerTickResult } from '../ports/scheduler.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { Emit } from './unit-of-work.js';
import { runSchedulerOnce, type SchedulerDeps } from './scheduler.js';
import { createSchedulerDeps, startScheduler, type SchedulerHandle } from './scheduler-start.js';

const BASE = Date.parse('2026-09-24T00:00:00.000Z');
const INTERVAL = 60_000;

type Tx = string;

interface Harness {
  deps: SchedulerDeps<Tx>;
  sink: MemorySink;
  runs: { ok: boolean }[];
  /** 让 job 的耗时可控（返回 resolve 的函数由用例自己决定何时调） */
  gateJob(name: string, gate: Promise<void>): SchedulerJob<Tx>;
}

function harness(): Harness {
  const sink = new MemorySink();
  const runs: { ok: boolean }[] = [];
  const clock: Clock = { now: () => new Date(BASE) };
  const deps: SchedulerDeps<Tx> = {
    clock,
    logger: createLogger({ env: 'test', destination: sink }),
    unitOfWork: async (fn) => {
      const collected: DomainEvent[] = [];
      const emit: Emit = (e) => collected.push(e);
      const value = await fn('TX', emit);
      collected.length = 0; // 假总线：分发即丢弃（本文件不验分发）
      return value;
    },
    savepoint: async (_tx, fn) => fn('SP'),
    lock: {
      async tryAcquire() {
        return true;
      },
    },
    runs: {
      async record(_tx, input) {
        runs.push({ ok: input.ok });
      },
    },
  };

  return {
    deps,
    sink,
    runs,
    gateJob: (name, gate) => ({
      name,
      async run() {
        await gate;
        return { processed: 1 };
      },
    }),
  };
}

/** 解锁用的把手：让用例能精确控制"这一轮还没跑完"。 */
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let handle: SchedulerHandle | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  vi.useRealTimers();
});

describe('定时器', () => {
  it('到点触发一次 tick（不用等真实 60 秒）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.ok).toBe(true); // 空 job 列表 = 全部成功
  });

  it('默认**启动即不跑**一次（避免与"上一个实例还没退干净"撞在一起）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });
    expect(h.runs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.runs).toHaveLength(1);
  });

  it('`runImmediately: true` 时立刻跑一次（部署后不想空等一分钟时用）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL, runImmediately: true });
    // tick 是异步的：推进 0ms 只为把已排队的微任务跑完（假定时器不会伪造 Promise）
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runs).toHaveLength(1);
  });

  it('`stop()` 之后不再触发（优雅关闭必须能让它停下来）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.runs).toHaveLength(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(h.runs).toHaveLength(1); // ← 没有再涨
  });
});

/**
 * OPS3-05：停机时 tick **不是** HTTP 请求——排空等不到它，事件 drain 也只等
 * 已 publish 的事件。在途那一轮必须有人等，否则它 emit 的 `order.expired`
 * 会在 `closeDb` 之后才分发（机构会话没作废 ⇒ 已过期的单还能被付款）。
 */
describe('停机：等在途的那一轮（OPS3-05）', () => {
  it('🔴 `stopAndWait()` 等在途 tick 跑完才 resolve（`stop()` 只清定时器，不等）', async () => {
    const h = harness();
    const gate = deferred();
    handle = startScheduler({
      deps: h.deps,
      jobs: [h.gateJob('slow', gate.promise)],
      intervalMs: INTERVAL,
    });

    const first = handle.tickNow();
    await vi.advanceTimersByTimeAsync(0); // 让 tick 进入 job（卡在 gate 上）

    let settled: boolean | undefined = undefined;
    const waiting = handle.stopAndWait(5_000).then((v) => {
      settled = v;
    });
    await vi.advanceTimersByTimeAsync(0);
    // ⚠️ 关键断言：此刻那一轮还没跑完 ⇒ 必须还等着（等不到的实现会在这里就 true）
    expect(settled).toBeUndefined();

    gate.resolve();
    await waiting;
    expect(settled).toBe(true);
    await first;
    expect(h.runs).toHaveLength(1); // 心跳确实写了：这一轮是**跑完**的，不是被打断的
  });

  it('🔴 预算到点仍在途 → 返回 false（不无限等，剩下的交给停机总预算）', async () => {
    const h = harness();
    const gate = deferred();
    handle = startScheduler({
      deps: h.deps,
      jobs: [h.gateJob('slow', gate.promise)],
      intervalMs: INTERVAL,
    });

    void handle.tickNow();
    await vi.advanceTimersByTimeAsync(0);

    // ⚠️ 不能 `await` 之后再推进假定时器——那样永远等不到超时（假时钟不会自己走）
    const waiting = handle.stopAndWait(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(false);
    // 超时后定时器已停：不会又开新一轮
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('没有在途轮次时立即返回 true（"没得等"也是等到，不该白耗停机时间）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });
    await expect(handle.stopAndWait(1_000)).resolves.toBe(true);
  });

  /**
   * @why `budgetMs <= 0` 是"调用方明确不想等"（测试、以及停机总预算已经算过之后
   *      的收尾），它与"超时尚未跑完"是**两个不同的返回值来源**：前者一进来就 false，
   *      后者要等满预算才 false。混成一条会让"到底等没等"在日志里说不清。
   */
  it('`stopAndWait(0)` = 明确不等：有在途轮次也立刻 false（不是"等满预算才 false"）', async () => {
    const h = harness();
    const gate = deferred();
    handle = startScheduler({
      deps: h.deps,
      jobs: [h.gateJob('slow', gate.promise)],
      intervalMs: INTERVAL,
    });
    void handle.tickNow();
    await vi.advanceTimersByTimeAsync(0); // 进入 job，卡在 gate 上（此刻真的有在途）
    await expect(handle.stopAndWait(0)).resolves.toBe(false);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
});

/**
 * @why 工厂那 5 个参数里的 `opts` 是**可选**的，而"可选"必须有断言：
 *      它承载的是"这一行心跳叫什么 / 抢哪把锁"（文件头 @why：tick 与 daily 复用
 *      同一段编排，靠它区分）。写成必填会把这个区分能力丢掉，写成不传却没测试，
 *      就会在某个 job 忘了传名字时静默变成"无名心跳"。
 */
describe('createSchedulerDeps（真实接线）', () => {
  it('不传 opts 时 name / lockKey 都是 undefined（不是写死一个名字）', () => {
    const deps = createSchedulerDeps(
      {} as unknown as Db,
      {} as unknown as EventBus,
      { now: () => new Date(BASE) },
      createLogger({ env: 'test', destination: new MemorySink() }),
    );
    expect(deps.name).toBeUndefined();
    expect(deps.lockKey).toBeUndefined();
    // 接线本身指向真实实现（不是被替身换掉）
    expect(typeof deps.unitOfWork).toBe('function');
    expect(typeof deps.savepoint).toBe('function');
    expect(typeof deps.lock.tryAcquire).toBe('function');
    expect(typeof deps.runs.record).toBe('function');
  });
});

describe('同一进程内的两轮重叠', () => {
  it('上一轮没跑完时，定时器触发的这一轮**直接跳过**（不并发开第二个事务）', async () => {
    const h = harness();
    const gate = deferred();
    handle = startScheduler({
      deps: h.deps,
      jobs: [h.gateJob('slow', gate.promise)],
      intervalMs: INTERVAL,
    });

    // 手动起第一轮（它卡在 gate 上）
    const first = handle.tickNow();
    await vi.advanceTimersByTimeAsync(INTERVAL); // 定时器到点 —— 此刻第一轮还没完成
    expect(h.runs).toHaveLength(0); // 心跳还没写（还卡着）
    expect(h.sink.find('scheduler_tick_overlap')).toHaveLength(1);

    gate.resolve();
    await first;
    expect(h.runs).toHaveLength(1);
  });

  it('`tickNow()` 在重叠时返回 undefined（调用方拿不到"本轮结果"，因为它根本没跑）', async () => {
    const h = harness();
    const gate = deferred();
    handle = startScheduler({
      deps: h.deps,
      jobs: [h.gateJob('slow', gate.promise)],
      intervalMs: INTERVAL,
    });

    const first = handle.tickNow();
    const second = await handle.tickNow();
    expect(second).toBeUndefined();

    gate.resolve();
    const r = await first;
    expect(r?.acquired).toBe(true);
  });
});

describe('容错：一轮抛错不能把进程拖死', () => {
  it('`runSchedulerOnce` 抛错被兜住并记 error（否则变成 unhandledRejection → 进程退出）', async () => {
    const h = harness();
    const broken: SchedulerDeps<Tx> = {
      ...h.deps,
      unitOfWork: async () => {
        throw new Error('心跳 SQL 炸了');
      },
    };
    handle = startScheduler({ deps: broken, jobs: [], intervalMs: INTERVAL });

    // 能 await 到这一行就说明没抛（抛了会以 unhandledRejection 的形式炸进程）
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const row = h.sink.find('scheduler_tick_error')[0];
    expect(row?.err_message).toBe('心跳 SQL 炸了');
    expect(row?.module).toBe('scheduler');
    // 手动调用同样不抛，且返回 undefined（调用方据此知道"这一轮没结果"）
    await expect(handle.tickNow()).resolves.toBeUndefined();
  });

  it('job 抛错**不算**这一层的错误（它是正常业务结果：ok=false + 心跳照写）', async () => {
    const h = harness();
    const boom: SchedulerJob<Tx> = {
      name: 'boom',
      async run() {
        throw new Error('job 炸了');
      },
    };
    handle = startScheduler({ deps: h.deps, jobs: [boom], intervalMs: INTERVAL });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(h.sink.find('scheduler_tick_error')).toHaveLength(0);
    expect(h.runs[0]?.ok).toBe(false);
  });

  it('本轮失败后**下一轮照常跑**（错误不会让调度器永久停摆）', async () => {
    const h = harness();
    const broken: SchedulerDeps<Tx> = {
      ...h.deps,
      unitOfWork: async () => {
        throw new Error('一次性故障');
      },
    };
    handle = startScheduler({ deps: broken, jobs: [], intervalMs: INTERVAL });

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(h.sink.find('scheduler_tick_error')).toHaveLength(3);
  });
});

describe('与编排层的衔接（真的调 runSchedulerOnce，不是另写一套）', () => {
  it('startScheduler 走的是同一个 runSchedulerOnce（心跳行名与口径一致）', async () => {
    const h = harness();
    const seen: string[] = [];
    handle = startScheduler({
      deps: {
        ...h.deps,
        runs: {
          async record(_tx, input) {
            seen.push(input.name);
            h.runs.push({ ok: input.ok });
          },
        },
      },
      jobs: [],
      intervalMs: INTERVAL,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(seen).toEqual([TICK_JOB_NAME]);
  });

  it('`tickNow()` 的返回值就是 `runSchedulerOnce` 的返回值（形状一致，可断言 acquired）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });

    const r: SchedulerTickResult | undefined = await handle.tickNow();
    expect(r).toBeDefined();
    expect(r?.acquired).toBe(true);
    expect(typeof r?.traceId).toBe('string');
  });

  it('跑完一轮之后可以再跑一轮（running 标记被正确复位）', async () => {
    const h = harness();
    handle = startScheduler({ deps: h.deps, jobs: [], intervalMs: INTERVAL });

    await handle.tickNow();
    const second = await handle.tickNow();
    expect(second).toBeDefined();
    expect(h.runs).toHaveLength(2);
  });

  it('未接线的情况下 runSchedulerOnce 本身仍可直接调用（测试友好）', async () => {
    const h = harness();
    const r = await runSchedulerOnce(h.deps, []);
    expect(r.acquired).toBe(true);
  });
});
