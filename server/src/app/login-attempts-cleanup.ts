/**
 * 职责：**定期清掉过期的登录尝试行**（A1 + B14 的收尾；AJ-187）——让 `login_attempts` 不是一张只增不删的表。
 *
 * @why 015 把登录失败计数搬出 users 之后，"被试探过的**不存在**的邮箱"也会留一行。
 *      这是一张**由攻击者决定行数**的表：换 IP 慢慢试探就能往里写行，
 *      而它既没有业务价值也没有人去看——不清就是一条"某天磁盘告警、但没人知道为什么"的伏笔。
 * @why 做成 `SchedulerJob` 而不是塞进登录请求里顺手清：清理频率与请求量无关，
 *      挂在请求上会出现"流量低时永远不清、流量高峰时每次登录都多一条 delete"；
 *      调度器有心跳（`job_runs`）与锁，"最后一次成功清理是什么时候"因此是**可回答**的。
 * @why 挂在 **daily** 端点（`internal-jobs-routes.ts`）而不是常驻 tick：
 *      保留窗口是 24 小时量级，一天一次足够；分钟级跑它对"隔夜的试探行"没有额外收益，
 *      只是把一条 delete 变成 1440 条。
 *
 * @limitation 一：只删**已解锁**的行（见 `deleteStaleLoginAttempts` 的 @why）——
 *              还在锁里的行是正在生效的安全状态，清掉等于给人一条"连错 5 次等一天就能重来"的捷径。
 * @limitation 二：`processed` 是删除行数；**0 是正常的**，不代表 job 失败（`ports/scheduler.ts` JobOutcome 口径）。
 *
 * @see ../adapters/admin-auth.ts（SQL 与保留窗口常量）；migrations/015_login_attempts.sql
 */
import type { Db } from '../adapters/db.js';
import {
  deleteStaleLoginAttempts,
  loginAttemptsCutoff,
  LOGIN_ATTEMPT_RETENTION_HOURS,
} from '../adapters/admin-auth.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const CLEANUP_LOGIN_ATTEMPTS_JOB = 'cleanup_login_attempts';

export function createCleanupLoginAttemptsJob(): SchedulerJob<Db> {
  return {
    name: CLEANUP_LOGIN_ATTEMPTS_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      // 基准时刻取**本轮作业的开始**（`ctx.startedAt`）而不是 `now()`：
      //    同一轮里所有 job 看到同一个基准，否则"24h 前"这条边界会随 job 执行先后漂移
      //    （@see ports/scheduler.ts JobContext.startedAt 的 @why）。
      //    而"减去 24h"这一步在 adapters 里做——业务侧不自己 `new Date()`（F10）。
      const cutoff = loginAttemptsCutoff(ctx.startedAt);
      const deleted = await deleteStaleLoginAttempts(ctx.tx, cutoff);
      ctx.log.info('login_attempts_cleanup', {
        result: 'ok',
        count: deleted,
        ctx: {
          retention_hours: LOGIN_ATTEMPT_RETENTION_HOURS,
          cutoff: cutoff.toISOString(),
        },
      });
      return { processed: deleted };
    },
  };
}
