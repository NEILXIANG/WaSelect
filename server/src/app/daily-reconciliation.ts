/**
 * 职责：**每日对账 job**（I1-U7b，欠账① / D-45）——把"需要人工看一眼"的三类账务异常
 *       扫出来，计数 + 取样落日志。
 *
 * @why 只**报告**不自动修：三类异常的处置都是"人看了再定"——
 *      ① initiated 支付行挂在已关闭的单上（D-50 连带作废 best-effort 失败的残留）：
 *         钱没扣，但支付行悬着，机构侧会话可能还活着；
 *      ② 订单 paid 但最近一条 payments 不是 succeeded（两本账不符）：
 *         mark-paid 设计上是同事务封口，出现即意味着有未知写路径；
 *      ③ 近 48h 回调登记为 needs_refund / late_payment / status_conflict / unmatched：
 *         "钱扣了但不能发货"与"钱到了找不到单"，每一条都要人工跟进。
 *      自动修任何一类都需要业务裁决（退不退？发不发？），MVP 把它留给人——
 *      但没有这个 job，这些行就只能在库里静默躺着（欠账①被评为致命级的原因）。
 *
 * @why 走 `SchedulerJob` 插在调度器框架里（与 expire-orders 同一白拿集合：
 *      advisory lock 多实例互斥 / savepoint / job_runs('daily') 心跳），
 *      由 `POST /internal/jobs/daily` 端点触发（Render Cron Job，D-43）——
 *      分钟级任务走常驻调度器，日级任务走 HTTP 触发，两种形态各归其位。
 *
 * @limitation 一：异常 id 清单**截断到 20 条**（计数不受截断影响）——
 *              日志不是报表，积压超过 20 条时人要的是"有多少"而不是"全部 id"。
 * @limitation 二：**只读**（不改任何行）。对账 job 在事务里跑只是为了共用框架的
 *              锁与心跳；它发现的问题一律靠人去修，不在事务里顺手改数据。
 * @limitation 三：三类是**三个视角，不是三个互斥集合**——同一行可以同时命中多类
 *              （典型：订单 paid 但支付行仍 initiated，既是①悬空支付、又是②两本账不符）。
 *              于是 `processed` 是**异常条数之和**，不是"有问题的行数"，更不是异常类数；
 *              读它时不要以为 4 条 = 4 个不同的问题。
 *
 * @see app/internal-jobs-routes.ts（触发端点）；app/expire-orders.ts（同一框架的兄弟 job）
 */
import type { Db } from '../adapters/db.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const DAILY_RECONCILIATION_JOB = 'daily_reconciliation';

/** 每类异常落日志的 id 取样上限（见文件头 @limitation 一）。 */
export const RECONCILE_IDS_CAP = 20;
/** 回调异常的回看窗口（小时）：再早的异常要么已处理、要么已沉底，每日扫全表没有意义。 */
export const RECONCILE_LOOKBACK_HOURS = 48;

interface AnomalyClass {
  /** 日志键与报告键（英文蛇形：日志检索口径）。 */
  key: string;
  count: number;
  /** 取样 id（≤ RECONCILE_IDS_CAP）；count > ids.length 即"还有更多"。 */
  ids: string[];
}

async function scanDanglingPayments(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string }[]>`
    select p.id from payments p
      join orders o on o.id = p.order_id
     where p.status = 'initiated'
       and o.status not in ('created', 'pending_payment')
     order by p.created_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from payments p
      join orders o on o.id = p.order_id
     where p.status = 'initiated'
       and o.status not in ('created', 'pending_payment')
  `;
  return {
    key: 'dangling_initiated_payments',
    count: Number(countRows[0]?.count ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.id)),
  };
}

async function scanLedgerMismatch(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string }[]>`
    select o.id from orders o
     where o.status = 'paid'
       and coalesce(
         (select p.status from payments p
           where p.order_id = o.id order by p.created_at desc limit 1),
         'none'
       ) <> 'succeeded'
     order by o.id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from orders o
     where o.status = 'paid'
       and coalesce(
         (select p.status from payments p
           where p.order_id = o.id order by p.created_at desc limit 1),
         'none'
       ) <> 'succeeded'
  `;
  return {
    key: 'paid_without_succeeded_payment',
    count: Number(countRows[0]?.count ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.id)),
  };
}

async function scanCallbackAnomalies(ctx: JobContext<Db>): Promise<AnomalyClass> {
  // ⚠️ 窗口下界在 SQL 里算（`startedAt - make_interval`），不在 JS 里 new Date——
  //    F10 禁业务侧 new Date：判定基准必须全部来自注入时钟（ctx.startedAt）
  const rows = await ctx.tx<{ event_id: string }[]>`
    select event_id from webhook_events
     where received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
       and (result in ('needs_refund', 'late_payment', 'status_conflict')
            or result like 'unmatched%')
     order by received_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from webhook_events
     where received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
       and (result in ('needs_refund', 'late_payment', 'status_conflict')
            or result like 'unmatched%')
  `;
  return {
    key: 'callback_anomalies_48h',
    count: Number(countRows[0]?.count ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.event_id)),
  };
}

export function createDailyReconciliationJob(): SchedulerJob<Db> {
  return {
    name: DAILY_RECONCILIATION_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const classes = [
        await scanDanglingPayments(ctx),
        await scanLedgerMismatch(ctx),
        await scanCallbackAnomalies(ctx),
      ];
      let anomalies = 0;
      for (const c of classes) {
        anomalies += c.count;
        if (c.count === 0) continue;
        // 异常必须 error 级：对账的唯一受众是"每天看一眼日志的人"，
        // info 会被日常流量淹掉；零异常时反而一行都不打（没有新闻就是最好的新闻，
        // 汇总行在下面统一打 info）
        ctx.log.error('reconciliation_anomaly', {
          result: 'needs_human',
          ctx: { class: c.key, count: c.count, sample_ids: c.ids },
        });
      }
      ctx.log.info('daily_reconciliation', {
        result: anomalies === 0 ? 'ok' : 'anomalies_found',
        ctx: Object.fromEntries(classes.map((c) => [c.key, c.count])),
      });
      return { processed: anomalies };
    },
  };
}
