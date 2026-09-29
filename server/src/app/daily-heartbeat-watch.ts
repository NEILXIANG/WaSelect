/**
 * 职责：**daily 作业停跑的看门狗**（B11 / AJ-196）——挂在常驻 tick 上，
 *       每轮只看一眼 `job_runs` 里 daily 那一行，停滞就打一条 error 日志。
 *
 * @why AJ-102 承诺的"tick / daily 互相看心跳"**只兑现了一半**：daily 的对账里有
 *      `scanStalledHeartbeats`，它看 tick；但**没有任何 tick 作业看 daily**——
 *      daily 自己看自己，等于"由被告报告自己有没有犯罪"。
 *      而 daily 一旦停跑，自动签收 / 自动完成与六类对账全部静默停止：
 *      已发货订单永远不签收、退款滞留无人报告，并且**全程没有任何报错**。
 *      停跑的原因又都是外部的：Render Cron 被删、密钥轮换后 cron 拿到 40101、
 *      上线漏配 cron——这类故障不会让任何一个请求失败，只能靠这种"没人报就是出事了"的探针发现。
 *
 * @why 挂在 **tick** 上而不是再加一个 Render Cron Job：cron 再挂一个"检查 cron"的 cron，
 *      它自己停了同样没人知道（无限递归，没有终点）。常驻进程的 tick 与 daily
 *      **分属两条独立链路**（进程内 setInterval vs 平台 cron），这才叫互相看。
 *      且 tick 自己也有一行心跳兜底：tick 真停了 daily 的扫描会报它。
 *
 * @limitation 一：**只报错，不做任何补救**。MVP 没有告警通道（同 `expire-orders`
 *              @limitation 一），而补救也只有人能做——上面三类原因都不是代码能自愈的。
 *              写"自动补跑一次 daily"会把"为什么停"这个真正要回答的问题盖掉，
 *              还可能把一轮日常对账跑在错误的时刻（对账的快照基准是它自己的 startedAt）。
 * @limitation 二：`last_success_at is null` 且进程没跑满
 *              {@link DAILY_NEVER_RAN_GRACE_HOURS} 小时**不算停滞**——
 *              新部署的头 26 小时里 daily 本来就没机会跑，那时 null 是正常的。
 *              ⚠️ 代价：一个"起来就没配 cron"的实例要等 26 小时才报警。
 *              换来的是"每次部署后不再误报"——误报一次，人就会把这类告警当噪音关掉，
 *              那比晚 26 小时发现更贵。
 * @limitation 三：**行不存在也算停滞**（`row_missing`）。`job_runs` 的 'daily' 行由迁移 seed，
 *              它不见只可能是被清了（或 seed 没跑）——那正是"看门狗在盯一个不存在的行"
 *              这种最坏的失效形态，必须响。
 * @limitation 四：它自己**不写** `job_runs`（它不是一轮作业，没有成败可记），
 *              所以"看门狗本身跑没跑"只能从 tick 的心跳间接看出来。这是刻意的：
 *              给它单独一行，马上又产生"谁来盯盯梢的人"这同一个问题。
 *
 * @see ports/scheduler.ts（DAILY_JOB_ROW_NAME / DAILY_STALL_HOURS / 宽限期的取值依据）；
 *      app/daily-reconciliation.ts（反方向：daily 看 tick）；
 *      app/auto-fulfilment.ts（daily 停跑后最先静默失效的作业）
 */
import type { Db } from '../adapters/db.js';
import {
  DAILY_JOB_ROW_NAME,
  DAILY_NEVER_RAN_GRACE_HOURS,
  DAILY_STALL_HOURS,
  type JobContext,
  type JobOutcome,
  type SchedulerJob,
} from '../ports/scheduler.js';

export const DAILY_HEARTBEAT_WATCH_JOB = 'daily_heartbeat_watch';

/** 停滞原因：进日志 `ctx.reason`，也让"下一步查什么"在日志里就有答案。 */
type StallReason = 'stale' | 'never_ran' | 'row_missing';

interface WatchRow {
  last_success_at: Date | null;
  stalled: boolean;
}

/**
 * @why 工厂而不是常量对象：`processStartedAt` 必须在**装配处**取一次（进程启动时刻），
 *      不能让 job 自己调 `now()`——那等于用"job 第一次跑的时刻"冒充"进程启动时刻"，
 *      第一次跑之前的那段空窗会被算成 0，宽限期判断随即失真（F10：时间只从外面进来）。
 */
export function createDailyHeartbeatWatchJob(input: {
  /** 进程启动时刻（`main.ts` 在挂调度器之前用注入时钟取一次）。 */
  processStartedAt: Date;
}): SchedulerJob<Db> {
  return {
    name: DAILY_HEARTBEAT_WATCH_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      // 🔴 时间判定**全在 SQL 里做**（`make_interval`），JS 侧不做任何 `new Date()`（F10）：
      //    ① 陈旧：上次成功早于「本轮开始 - 26h」；
      //    ② 从没跑过：null 且进程已起来超过宽限期（否则新部署的头 26 小时必然误报）。
      const rows = await ctx.tx<WatchRow[]>`
        select last_success_at,
               (   last_success_at is null
                   and ${ctx.startedAt}::timestamptz
                       - make_interval(hours => ${DAILY_NEVER_RAN_GRACE_HOURS})
                       >= ${input.processStartedAt}::timestamptz
               ) or (   last_success_at is not null
                   and last_success_at < ${ctx.startedAt}::timestamptz
                                          - make_interval(hours => ${DAILY_STALL_HOURS})
               ) as stalled
          from job_runs
         where name = ${DAILY_JOB_ROW_NAME}
      `;
      const row = rows[0];
      // 行不存在 = 盯了一个不存在的行（@limitation 三），必须响，不能当"没事"
      if (row === undefined) {
        ctx.log.error('daily_heartbeat_stalled', {
          result: 'fail',
          ctx: { reason: 'row_missing' satisfies StallReason, name: DAILY_JOB_ROW_NAME },
        });
        return { processed: 1 };
      }
      if (!row.stalled) return { processed: 0 };

      const reason: StallReason = row.last_success_at === null ? 'never_ran' : 'stale';
      ctx.log.error('daily_heartbeat_stalled', {
        result: 'fail',
        ctx: {
          reason,
          last_success_at: row.last_success_at?.toISOString() ?? null,
          // 起来了多久（小时，一位小数）：区分"新部署还没到第一次"与"起来很久了一次没跑"
          uptime_hours:
            Math.round(
              ((ctx.startedAt.getTime() - input.processStartedAt.getTime()) / 3_600_000) * 10,
            ) / 10,
          stall_hours: DAILY_STALL_HOURS,
        },
      });
      return { processed: 1 };
    },
  };
}
