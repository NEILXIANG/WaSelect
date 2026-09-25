/**
 * 职责：常驻调度器的**启动**（D-43）与**真实接线**——把 `Db` / 事件总线装配成 `SchedulerDeps`。
 *
 * 边界：不含任何编排规则（在 `app/scheduler.ts`）、不含 SQL（在 `adapters/scheduler.ts`）。
 *
 * @why 拆成两个文件而不是塞进 `scheduler.ts`：
 *      `scheduler.ts` 的 `TTx` 是**泛型**——它对事务句柄零要求，所以单测能用 `string` 当句柄
 *      跑完所有分支。一旦把"用 postgres.js 的 `Db` 装配"写进去，那份可测性就没了
 *      （要为它准备一个能跑事务/锁/savepoint 的替身，而替身的行为是**我自己写的**）。
 *      装配与使用分开，是"能单测"这件事的前提，不是洁癖。
 *
 * @why **`setInterval` 而不是 Render Cron Job**（D-43 已定，此处只说明代价）：
 *      ① Cron Job 是**另一个进程**，它拿不到本进程的连接池与健康状态，出问题要看两个地方；
 *      ② 它按**绝对时钟**触发，不关心上一轮跑完没有，重叠要靠外部再想办法；
 *      ③ 多实例部署时 Cron Job 会在**每个实例上各跑一次**，反而更需要互斥。
 *      常驻在 web 进程里的代价是"进程挂了调度就停"——而这正好被 `job_runs` 心跳覆盖：
 *      心跳停了 = 该告警。两件事互相补位，不是重复建设。
 *
 * @limitation 一：**单进程内的重叠**靠一个 `running` 标记挡掉，它是**进程内**状态，
 *              挡不住跨进程——跨进程由 advisory lock 负责（见 `adapters/scheduler.ts`）。
 *              两层都要有：只靠锁的话，重叠的那一轮会白开一个事务去抢锁再跳过，
 *              白白消耗一条连接，且"抢不到"与"没抢"在日志里长得一样。
 * @limitation 二：`stop()` **不打断**已经在跑的那一轮（只停定时器）。
 *              打断会让事务停在半开状态（`idle_in_transaction_session_timeout` 兜底 60s 才杀），
 *              优雅关闭的正确顺序是"先摘流量 → 停定时器 → 等在途请求 → 关连接池"。
 * @limitation 三：定时器 `unref()` 了——它**不会**让进程活着。
 *              生产上进程由 HTTP 服务器撑着；若哪天"只剩调度器"的进程形态出现，要把这一行去掉。
 *
 * @see ./scheduler.ts（编排）；../adapters/scheduler.ts（SQL）；
 *      ../ports/scheduler.ts（契约）；docs/地基搭建清单.md F13；D-43
 */
import { withSavepoint, type Db } from '../adapters/db.js';
import { createJobRunLog, createSchedulerLock } from '../adapters/scheduler.js';
import { errorLogFields } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import { oneLineError, type SchedulerJob, type SchedulerTickResult } from '../ports/scheduler.js';
import { runSchedulerOnce, type SchedulerDeps } from './scheduler.js';
import { withUnitOfWork } from './unit-of-work.js';

/**
 * 真实接线：`Db` + 事件总线 → `SchedulerDeps<Db>`。
 *
 * @why 工厂而不是导出一个单例：同一段编排要被 **tick 与 daily 两个定时任务**复用
 *      （`name` / `lockKey` 不同），单例会把"这一行心跳叫什么"写死。
 */
export function createSchedulerDeps(
  db: Db,
  bus: EventBus,
  clock: Clock,
  logger: Logger,
  opts: { name?: string | undefined; lockKey?: string | undefined } = {},
): SchedulerDeps<Db> {
  return {
    unitOfWork: (fn) => withUnitOfWork(db, bus, fn),
    // 直接引用而不是包一层：它是 `adapters/db.ts` 里已经写好并测过的实现，
    // 再包一层只是多一处可能忘记转发参数的地方。
    savepoint: withSavepoint,
    lock: createSchedulerLock(),
    runs: createJobRunLog(),
    clock,
    logger,
    name: opts.name,
    lockKey: opts.lockKey,
  };
}

/** 启动后的把手。 */
export interface SchedulerHandle {
  /**
   * 立刻跑一轮（不等定时器）。
   * @returns 本轮结果；**`undefined` = 这一轮没跑**（上一轮还没结束，见文件头 @limitation 一）
   */
  tickNow(): Promise<SchedulerTickResult | undefined>;
  /** 停止定时器。已开始的那一轮不打断（见 @limitation 二）。 */
  stop(): void;
}

export interface StartSchedulerOptions<TTx> {
  deps: SchedulerDeps<TTx>;
  jobs: readonly SchedulerJob<TTx>[];
  /** tick 间隔（毫秒）。取自配置的 `SCHEDULER_TICK_MS`（≥1000，配置层已校验）。 */
  intervalMs: number;
  /**
   * 启动后是否立刻跑一次（默认 **false**）。
   * @why 默认不跑：部署时的典型形态是"新实例起来了、旧实例还没退干净"，
   *      此刻立刻跑必然抢不到锁（旧实例正持有），于是新实例的第一次心跳被记为"跳过"——
   *      看门狗看到的是"刚部署完就有一轮没跑"，会误报。等一个间隔再跑，重叠期已过。
   */
  runImmediately?: boolean;
}

/**
 * 启动常驻调度器。
 *
 * @why 定时器回调里**必须** catch：`setInterval` 的回调抛出的 rejection 没有任何人接，
 *      直接变成 `unhandledRejection`——Node 默认配置下**整个进程退出**。
 *      即"某个 job 抛了一次异常"会导致服务重启，而日志上只看到"进程没了"。
 *      这是本函数存在的主要理由之一。
 */
export function startScheduler<TTx>(opts: StartSchedulerOptions<TTx>): SchedulerHandle {
  const log = opts.deps.logger.child({ module: 'scheduler', actor: 'scheduler' });
  let running = false;

  const tick = async (): Promise<SchedulerTickResult | undefined> => {
    if (running) {
      // 用 warn 而不是 debug：60 秒的间隔下出现重叠意味着"一轮要跑超过 60 秒"，
      // 那是要人来看的信号（要么 job 太慢，要么该拆 tick）。
      log.warn('scheduler_tick_overlap', { reason: '上一轮还没跑完，本轮跳过' });
      return undefined;
    }
    running = true;
    try {
      return await runSchedulerOnce(opts.deps, opts.jobs);
    } catch (err) {
      log.error('scheduler_tick_error', {
        ...errorLogFields(err),
        // ⚠️ 同 `scheduler.ts`：`errorLogFields` 的 `err_message` 是未脱敏原文，
        //    必须放在展开**之后**覆盖它（logger 不做自动脱敏）。
        err_message: oneLineError(err),
      });
      return undefined;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  timer.unref(); // 见文件头 @limitation 三
  if (opts.runImmediately === true) void tick();

  return {
    tickNow: tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}
