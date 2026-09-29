/**
 * 职责：**自动签收 / 自动完成**两个每日作业（PRD P0，D-39：发货后 AUTO_DELIVER_DAYS 天自动签收、
 *       签收后 AUTO_COMPLETE_DAYS 天自动完成；O-12 / AJ-182）。挂在每日作业（`POST /internal/jobs/daily`）里。
 *
 * @why 日级而不是分钟级（不进常驻 tick）：阈值是"天"，晚几个小时毫无业务差别；放进 tick 等于每分钟扫一次表。
 *      挂在每日作业里还白拿看门狗：daily 心跳停滞会被每日对账报 stalled_heartbeats。
 * @why 排在每日对账**之前**（internal-jobs-routes.ts 的 jobs 顺序）：对账看到的是迁移之后的状态。
 * @why 同一轮先签收、后完成：刚被自动签收的单 delivered_at = 本轮时刻，不会被同一轮连带完成（测试钉住）。
 * @limitation 一：没有"妥投"数据源——签收是**按时间推定**，不是承运商回传（承运商轨迹接入属 P1）。
 *              30 天的取值见 .env.example（EMS 到美 7–14 天 + 清关抽查）。
 * @limitation 二：不通知买家（通知通道未建，同 expire-orders @limitation 一）。
 * @limitation 三：单轮上限 AUTO_ADVANCE_BATCH_LIMIT；积压时分多天消化（与 EXPIRE_BATCH_LIMIT 同口径，代码常量不是配置）。
 *
 * @see adapters/orders.ts autoAdvanceOrders（SQL 与拒付排除）；app/expire-orders.ts（同一框架的兄弟 job）；
 *      PRD v1.6 §3 订单管理（标记签收 MVP 由 30 天自动）；D-39
 */
import type { Db } from '../adapters/db.js';
import { autoAdvanceOrders } from '../adapters/orders.js';
import { plusMs } from '../adapters/clock.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const AUTO_DELIVER_JOB = 'auto_deliver';
export const AUTO_COMPLETE_JOB = 'auto_complete';
/** 单轮最多迁多少单（@limitation 三）。 */
export const AUTO_ADVANCE_BATCH_LIMIT = 500;

const DAY_MS = 86_400_000;

function advanceJob(
  name: string,
  to: 'delivered' | 'completed',
  logKey: string,
  afterDays: number,
): SchedulerJob<Db> {
  return {
    name,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const ids = await autoAdvanceOrders(ctx.tx, to, {
        dueBefore: plusMs(ctx.startedAt, -afterDays * DAY_MS),
        at: ctx.startedAt,
        note: `auto:${String(afterDays)}d`,
        limit: AUTO_ADVANCE_BATCH_LIMIT,
      });
      ctx.log.info(logKey, {
        result: 'ok',
        count: ids.length,
        ctx: { after_days: afterDays, batch_limit: AUTO_ADVANCE_BATCH_LIMIT },
      });
      return { processed: ids.length };
    },
  };
}

/** 自动签收：shipped 且 shipped_at 满 afterDays 天 → delivered。 */
export function createAutoDeliverJob(opts: { afterDays: number }): SchedulerJob<Db> {
  return advanceJob(AUTO_DELIVER_JOB, 'delivered', 'orders_auto_delivered', opts.afterDays);
}

/** 自动完成：delivered 且 delivered_at 满 afterDays 天 → completed。 */
export function createAutoCompleteJob(opts: { afterDays: number }): SchedulerJob<Db> {
  return advanceJob(AUTO_COMPLETE_JOB, 'completed', 'orders_auto_completed', opts.afterDays);
}
