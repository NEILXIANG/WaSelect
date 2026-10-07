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
  /**
   * 锁键（默认 {@link TICK_LOCK_KEY}）。
   * @why 写成 `string | undefined` 而不是 `string`：`exactOptionalPropertyTypes` 下，
   *      装配层（`scheduler-start.ts`）要把"调用方没给"直接透传进来，
   *      不写 `| undefined` 就得改成条件赋值，那是把一件事拆成两步写。
   */
  lockKey?: string | undefined;
  /** 心跳行名（默认 {@link TICK_JOB_NAME}）；daily 对账传 'daily'。 */
  name?: string | undefined;
}

/**
 * job 专用日志器：强制带上 `job` / `module` / `actor`。
 *
 * @why 包一层把 `job` 硬塞进每一次调用的 fields，且**放在展开之后**——
 *      调用方想伪造 `job` 也伪造不了（与保留键同一套思路）。
 *      复核 AJ-59（2026-10-06）订正：原先这里还写"`child({ job })` 会被静默丢掉"，不成立——
 *      `child()` 只拦保留键（logger.ts 的 splitReserved），`job` 不是保留键，会正常带上
 *      （@measured：`log.child({module:'scheduler',actor:'scheduler',job:'close-expired'}).info('probe_evt')`
 *      输出含 `"job":"close-expired"`）。保留这层包装的理由只剩"不可被调用方覆盖"。
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
      // ⚠️ 必须放在展开**之后**：`errorLogFields` 里的 `err_message` 是**未处理的原始** message。
      //    logger 的 emit 会自动过 `redact()`（logger.ts），但 redact 对"自由文本里嵌着敏感内容"
      //    （SQL、堆栈、上游报文）无能为力（redact.ts @limitation 三 / logger.ts @limitation 一），
      //    所以原始 message 必须在调用点换成 `oneLineError` 的净化版，不能指望日志层兜底；
      //    写在展开之前会被覆盖回去，于是"净化"这件事悄悄失效（曾被本文件的用例实测抓到过一次）。
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
  /**
   * 沿用的 trace_id（P2-26，AJ-386）：由 HTTP 触发的一轮（`/internal/jobs/daily`）传入请求的 trace，
   * 于是 cron 看到的 202、作业日志、`job_runs.trace_id` 是同一个值；进程内定时器不传，自建一条。
   */
  opts: { traceId?: string | undefined } = {},
): Promise<SchedulerTickResult> {
  const traceId = opts.traceId ?? newTraceId();
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
        /**
         * 🔴 0.6.27（AJ-320）：这个和是**跨 job 求和**，量纲混杂，**只能当"本轮有产出"的标记**，
         *    ⛔ **不能**当异常条数读——`migrations/012` 原文那条"0 好 / >0 该看"的口径已作废。
         *
         * @why 求和之所以"没有意义"（`ports/scheduler.ts` @limitation 二）：
         *      tick 一轮三个 job = 关掉的单数 + 删掉的幂等行数 + 看门狗的 0/1 停跑标志；
         *      daily 一轮四个 job = 自动签收数 + 自动完成数 + 对账异常数 + 清理行数。
         *      它们的量纲不同，加起来既不是异常数也不是工作量。
         * @why 它骗人的**方向最坏**：最该被看见的那一支——**daily 停跑**——在和里只贡献 **1**，
         *      数值最小、看着最无害；而每天自动签收几十单贡献几十，看着最"像异常"。
         *      按 012 的旧口径设阈值告警，结果是"正常运营时天天报警、真停跑时只亮一个 1"。
         * @why **保留写入、只订正读法**，而不是撤掉这一列：它今天在事实上承担了
         *      "本轮跑完了"的表内标记（`internal-jobs.db.test` 就用它当等待判据——
         *      `last_success_at` 被基线预置成健康值，等它出现会等到基线而不是本轮）。
         *      撤掉它 = 改那条 db 用例的判据（换 `trace_id` / `updated_at`，且基线要同步清），
         *      属**另一处改动**，不混在一轮逐行审查里做——已登记为未做的正解。
         * @limitation 想"看一眼 job_runs 就知道扫出几条异常"，今天**做不到**：
         *              对账的异常数只在 `daily-reconciliation` 的汇总日志里（带分类计数），
         *              表里这一列是四五个 job 的混合物。要做成"看表即知"需另立项
         *              （每 job 一行心跳，或给这一行加一列只对账数）。
         */
        const processed = results.reduce((sum, r) => sum + (r.ok ? r.processed : 0), 0);
        await deps.runs.record(tx, {
          name: deps.name ?? TICK_JOB_NAME,
          ok,
          error: aggregateJobError(results),
          traceId,
          processed,
          at: deps.clock.now(),
        });
        log.info('scheduler_tick_done', {
          ok,
          jobs: results.length,
          // 按 job 名分别给（契约 @limitation 二："日志里必须带上 job 名"）；
          // 失败的 job 没有 processed，给 null 而不是 0——"没上报"不能被读成"0 条"
          processed_by_job: results.map((r) => ({
            job: r.name,
            processed: r.ok ? r.processed : null,
          })),
        });
        return { ok, results };
      });

      const durationMs = deps.clock.now().getTime() - startedAt.getTime();
      if (ran === undefined) return { acquired: false, traceId, durationMs };
      return { acquired: true, ok: ran.ok, jobs: ran.results, traceId, durationMs };
    },
  );
}
