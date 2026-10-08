/**
 * 职责：**用户行为记录的 180 天保留期清理**（AJ-413）——让隐私政策里"使用记录保存 180 天后删除"这句话真的成立。
 *
 * @why 做成 `SchedulerJob`、挂在 **daily** 端点（`internal-jobs-routes.ts`）：保留期是天级量级，一天一次足够；
 *      调度器有心跳（`job_runs`）与锁，"最后一次成功清理是什么时候"因此是可回答的（与 login-attempts-cleanup 同一条理由）。
 * @why **分批 + 每轮封顶**：daily 的全部 job 在同一个事务里跑（scheduler.ts），一次把几十万行积压删完
 *      会让这个事务持锁到天亮、WAL 暴涨，还拖住后面的对账。封顶后"今天没删完"必须**看得见**——
 *      日志里 `capped: true`，而不是被每天一条 ok 盖住；积压留到明天接着删。
 * @why 基准时刻取 `ctx.startedAt`（本轮作业的开始）而不是 `now()`：同一轮里所有 job 看到同一个基准
 *      （@see ports/scheduler.ts JobContext.startedAt 的 @why）；"减 180 天"在 adapters 里做（F10：业务侧不 `new Date()`）。
 *
 * @limitation 一：`processed` 是删除行数；**0 是正常的**（JobOutcome 口径）。
 * @limitation 二：每轮最多 `USER_EVENTS_RETENTION_MAX_BATCHES × USER_EVENTS_PURGE_BATCH` = 10 万行。
 *              日均埋点若长期高于这个数，积压会越滚越大——那时先看 `capped` 连续出现几天，再调上限或改成分钟级。
 * @limitation 三：删除依赖触发器的事务内窄口（迁移 036）；若有人把本 job 挪到事务外跑，每天会红一条 42501，
 *              而不是静默不删——`user-events.db.test.ts` 边 ③ 钉住了这一点。
 *
 * @see ../adapters/user-events.ts（SQL、保留期常量）；./internal-jobs-routes.ts（接线）；docs/自主决策记录.md AJ-413
 */
import type { Db } from '../adapters/db.js';
import {
  purgeExpiredUserEvents,
  USER_EVENTS_PURGE_BATCH,
  USER_EVENTS_RETENTION_DAYS,
  userEventsRetentionCutoff,
} from '../adapters/user-events.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const USER_EVENTS_RETENTION_JOB = 'user_events_retention';
/** 每轮最多跑的批次数（@limitation 二）。 */
export const USER_EVENTS_RETENTION_MAX_BATCHES = 20;

export function createUserEventsRetentionJob(): SchedulerJob<Db> {
  return {
    name: USER_EVENTS_RETENTION_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const cutoff = userEventsRetentionCutoff(ctx.startedAt);
      let total = 0;
      let batches = 0;
      let lastBatch = 0;
      do {
        lastBatch = await purgeExpiredUserEvents(ctx.tx, cutoff);
        total += lastBatch;
        batches += 1;
      } while (lastBatch >= USER_EVENTS_PURGE_BATCH && batches < USER_EVENTS_RETENTION_MAX_BATCHES);
      // 最后一批仍是满批 ⇒ 还有积压没删到（今天封顶了）
      const capped = lastBatch >= USER_EVENTS_PURGE_BATCH;
      ctx.log.info('user_events_retention', {
        result: 'ok',
        count: total,
        ctx: {
          retention_days: USER_EVENTS_RETENTION_DAYS,
          cutoff: cutoff.toISOString(),
          batches,
          capped,
        },
      });
      return { processed: total };
    },
  };
}
