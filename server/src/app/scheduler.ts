/**
 * 职责：**一轮 tick 的编排**（F13）——取锁 → 顺序跑子任务（各自 savepoint）→ 写心跳 → 提交后分发事件。
 *
 * 边界：不含任何 SQL（在 `adapters/scheduler.ts`）、不含 setInterval（在 `app/scheduler-start.ts`）、
 *      不认识**任何一个**具体 job（全部由调用方传进来）。
 *
 * @why 编排单独成一层而不是塞进 job 里：下面三条性质是**所有**定时任务共有的，
 *      且每一条写错了都不报错——
 *      ① 抢不到锁就什么都不做（否则多实例各跑一遍，日志翻倍、心跳互相覆盖）；
 *      ② 一个子任务失败不影响其它子任务（否则一条坏单会永久卡住所有定时任务）；
 *      ③ 事件只在事务提交后分发（否则回滚了通知却已发出）。
 *      让每个 job 作者各自实现一遍，等于把三条都交给概率。
 *
 * @why `TTx` 是泛型而不是直接写 `Db`：本文件对事务句柄**没有任何**要求
 *      （只用 `unitOfWork` / `savepoint` / `lock` / `runs` 四个注入的函数），
 *      单测里用 `string` 当句柄就能跑完全部分支——这正是"分层"带来的可测性。
 *
 * @limitation 一：子任务**顺序**执行，不做并发。同一批订单之间常有先后依赖
 *      （先关单、再自动签收），并行会让"同一条订单被两个 job 同时改"变成新问题，
 *      而收益是零——MVP 每轮只处理几十条。将来真要并行，正确的做法是**拆成两把锁两个 tick**，
 *      不是在同一个事务里并发。
 * @limitation 二：一轮 tick **一个** trace_id（不是每个 job 一个）。一轮 tick 是一个操作，
 *      拆成多条链就看不到"同一个 tick 里 A 关了 3 单、B 失败"这个组合事实（取舍见 AJ-57）。
 * @limitation 三：`unitOfWork` 抛错时（比如心跳 SQL 失败）本函数**直接抛出**，不吞。
 *      调用方（`startScheduler`）负责兜住并记日志——吞掉会让"心跳写不进去"变成无人察觉的事。
 *
 * @see ../ports/scheduler.ts（契约与三条口径）；../adapters/scheduler.ts（SQL）；
 *      ./unit-of-work.ts（提交后分发）；../context.ts @limitation 一（定时任务自建链）；
 *      docs/地基搭建清单.md F13；docs/自主决策记录.md AJ-57 / AJ-58
 */
import { newTraceId, runWithContext } from '../context.js';
import { errorLogFields } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { DomainEvent } from '../ports/events.js';
import {
  aggregateJobError,
  allJobsOk,
  oneLineError,
  TICK_JOB_NAME,
  TICK_LOCK_KEY,
  type JobLogger,
  type JobResult,
  type JobRunLog,
  type SchedulerJob,
  type SchedulerLock,
  type SchedulerTickResult,
} from '../ports/scheduler.js';
import type { Emit } from './unit-of-work.js';

/** 编排所需的全部注入。除 `logger` 外没有一样是"全局可得"的——这是能单测的前提。 */
export interface SchedulerDeps<TTx> {
  /** 事务 + **提交之后**分发事件（见 unit-of-work.ts 的 @how）。 */
  unitOfWork: <T>(fn: (tx: TTx, emit: Emit) => Promise<T>) => Promise<T>;
  /** 事务内的嵌套单元：一个子任务失败时只回滚它自己。 */
  savepoint: <T>(tx: TTx, fn: (sp: TTx) => Promise<T>) => Promise<T>;
  lock: SchedulerLock<TTx>;
  runs: JobRunLog<TTx>;
  clock: Clock;
  logger: Logger;
  /** 锁键（默认 {@link TICK_LOCK_KEY}）。 */
  lockKey?: string;
  /** 心跳行名（默认 {@link TICK_JOB_NAME}）。 */
  name?: string;
}

/**
 * job 专用日志器：强制带上 `job` / `module` / `actor`。
 *
 * @why 不直接把 `Logger` 交给 job：`logger.child()` **只接受 module 与 actor** 两个键
 *      （见 logger.ts 的 CHILD_BINDABLE_KEYS），所以 `child({ job })` 会被**静默丢掉**——
 *      表现为"日志里根本没有 job 字段"，而写代码的人以为自己已经绑上了。
 *      包一层把 `job` 硬塞进每一次调用的 fields，且**放在展开之后**——
 *      调用方想伪造 `job` 也伪造不了（与保留键同一套思路）。
 */
function jobLogger(logger: Logger, job: string): JobLogger {
  const log = logger.child({ module: 'scheduler', actor: 'scheduler' });
  const withJob = (
    event: string,
    fields?: Record<string, unknown>,
  ): [string, Record<string, unknown>] => [event, { ...fields, job }];
  return {
    debug: (event, fields) => log.debug(...withJob(event, fields)),
    info: (event, fields) => log.info(...withJob(event, fields)),
    warn: (event, fields) => log.warn(...withJob(event, fields)),
    error: (event, fields) => log.error(...withJob(event, fields)),
  };
}

/**
 * 跑一个子任务：成功则把它的事件登记进整轮，失败则**连同事件一起丢弃**。
 *
 * @why `for (const e of collected) emit(e)` 这一行的位置是本函数存在的理由，
 *      必须**在 `savepoint` 成功返回之后**：job 完全可能"emit 完再抛错"，
 *      此时它的数据库写入已随 savepoint 回滚，若事件却登记了，
 *      就会造出"数据库里没有这笔变更、但外部动作已经发生"的幽灵副作用
 *      （与 unit-of-work.ts 文件头 @why 同一个事故，只是发生在一层嵌套之内）。
 */
async function runOneJob<TTx>(
  deps: SchedulerDeps<TTx>,
  job: SchedulerJob<TTx>,
  tx: TTx,
  emit: Emit,
  startedAt: Date,
): Promise<JobResult> {
  const t0 = deps.clock.now().getTime();
  const collected: DomainEvent[] = [];
  const log = jobLogger(deps.logger, job.name);
  try {
    const outcome = await deps.savepoint(tx, (sp) =>
      job.run({
        tx: sp,
        emit: (event) => collected.push(event),
        startedAt,
        log,
      }),
    );
    // ⚠️ 只有走到这里，这个 job 的写入才确定不会被回滚——事件此刻才成立。
    for (const event of collected) emit(event);

    const durationMs = deps.clock.now().getTime() - t0;
    log.info('scheduler_job_done', { processed: outcome.processed, duration_ms: durationMs });
    return { name: job.name, ok: true, processed: outcome.processed, durationMs };
  } catch (err) {
    const durationMs = deps.clock.now().getTime() - t0;
    const error = oneLineError(err);
    log.error('scheduler_job_failed', {
      duration_ms: durationMs,
      ...errorLogFields(err),
      // ⚠️ 必须放在展开**之后**：`errorLogFields` 里的 `err_message` 是**未脱敏的原始** message，
      //    而 logger 不做自动脱敏（已核实）——写在前面会被它覆盖回去，于是"脱敏"这件事悄悄失效。
      //    这是 logger.ts @limitation 四 点名的"重复键覆盖"，被本文件的用例实测抓到过一次。
      err_message: error,
    });
    return { name: job.name, ok: false, error, durationMs };
  }
}

/**
 * 跑一轮 tick。测试可以直接调用（不需要起定时器）。
 *
 * @throws `unitOfWork` 抛出的任何错误（事务已回滚、事件未分发，见文件头 @limitation 三）
 */
export async function runSchedulerOnce<TTx>(
  deps: SchedulerDeps<TTx>,
  jobs: readonly SchedulerJob<TTx>[],
): Promise<SchedulerTickResult> {
  const traceId = newTraceId();
  // 定时任务不在任何请求的异步链里，必须自己建一条——context.ts @limitation 一 点名的就是这里。
  return runWithContext(
    { trace_id: traceId, module: 'scheduler', actor: 'scheduler' },
    async () => {
      const startedAt = deps.clock.now();
      const log = deps.logger.child({ module: 'scheduler', actor: 'scheduler' });

      const ran = await deps.unitOfWork(async (tx, emit) => {
        const acquired = await deps.lock.tryAcquire(tx, deps.lockKey ?? TICK_LOCK_KEY);
        if (!acquired) {
          // 不是错误：另一个实例正在做这件事。用 debug 而不是 warn——
          // 每 60 秒一次的正常跳过若打 warn，会把"真的失败"淹掉。
          log.debug('scheduler_tick_skipped', { reason: '另一个实例正在执行' });
          return undefined;
        }

        const results: JobResult[] = [];
        for (const job of jobs) {
          results.push(await runOneJob(deps, job, tx, emit, startedAt));
        }

        const ok = allJobsOk(results);
        await deps.runs.record(tx, {
          name: deps.name ?? TICK_JOB_NAME,
          ok,
          error: aggregateJobError(results),
          traceId,
          at: deps.clock.now(),
        });
        log.info('scheduler_tick_done', {
          ok,
          jobs: results.length,
          processed: results.reduce((sum, r) => sum + (r.ok ? r.processed : 0), 0),
        });
        return { ok, results };
      });

      const durationMs = deps.clock.now().getTime() - startedAt.getTime();
      if (ran === undefined) return { acquired: false, traceId, durationMs };
      return { acquired: true, ok: ran.ok, jobs: ran.results, traceId, durationMs };
    },
  );
}
