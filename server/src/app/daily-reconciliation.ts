/**
 * 职责：**每日对账 job**（I1-U7b，欠账① / D-45）——把"需要人工看一眼"的三类账务异常
 *       扫出来，计数 + 取样落日志。
 *
 * @why 只**报告**不自动修：三类异常的处置都是"人看了再定"——
 *      ① initiated 支付行挂在已关闭的单上（D-50 连带作废 best-effort 失败的残留）：
 *         钱没扣，但支付行悬着，机构侧会话可能还活着；
 *      ② 订单 paid 但最近一条 payments 不是 succeeded（两本账不符）：
 *         mark-paid 设计上是同事务封口，出现即意味着有未知写路径；
 *      ③ 近 48h 回调登记为 late_payment / mismatch:* / ignored:status_conflict / unmatched:*（词表 app/webhook-results.ts）：
 *         "钱扣了但不能发货"与"钱到了找不到单"，每一条都要人工跟进；
 *      ④ 调度器心跳停滞（AJ-102 的替代方案）；
 *      ⑤ 卡住的回调：登记了却没有任何结果、租约已过期（KD-2 / AJ-175，见 scanUnfinishedCallbacks）。
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
import {
  TICK_JOB_NAME,
  type JobContext,
  type JobOutcome,
  type SchedulerJob,
} from '../ports/scheduler.js';
import {
  RESULT_LATE_PAYMENT,
  RESULT_MISMATCH_PREFIX,
  RESULT_STATUS_CONFLICT,
  RESULT_UNMATCHED_PREFIX,
} from './webhook-results.js';

export const DAILY_RECONCILIATION_JOB = 'daily_reconciliation';

/** 每类异常落日志的 id 取样上限（见文件头 @limitation 一）。 */
export const RECONCILE_IDS_CAP = 20;
/** 回调异常的回看窗口（小时）：再早的异常要么已处理、要么已沉底，每日扫全表没有意义。 */
export const RECONCILE_LOOKBACK_HOURS = 48;

/**
 * 卡住回调的判定阈值（分钟）：登记后超过这么久仍**没有任何处理结果**、且租约已过期 → 卡住。
 * @why 15 分钟（KD-2，AJ-175 拍板）：回调处理租约是秒级的，正常一条回调在秒级内就有结果；
 *      机构的重发节奏是分钟级起步（Stripe 官方口径为最长约 3 天的指数退避；各机构首轮间隔未逐一实测），
 *      15 分钟足以区分"正在重试的正常抖动"与"没人会再来处理的孤儿"。取更短会把正在排队的早到回调（grace）误报；
 *      取更长（如 1 小时）则在每日对账这种低频作业里没有额外收益——作业一天只跑一次，
 *      阈值只是用来排除"刚刚到、还在处理"的那几分钟。
 */
export const UNFINISHED_CALLBACK_MINUTES = 15;

/**
 * 心跳停滞阈值：**tick**（常驻调度器，60s 一轮）超过这个分钟数没有成功心跳 = 卡了。
 * @why 取 10 分钟而不是 2 分钟：一轮最坏要跑完所有 job，偶发一轮超时不该报警；
 *      取 10 是"卡住"与"慢了一轮"的分界（60s × 10）。
 */
export const TICK_STALL_MINUTES = 10;
/**
 * 心跳停滞阈值：**daily**（每日作业，24h 一轮）超过这个小时数没有成功心跳 = 没跑。
 * @why 26 小时而不是 24：cron 触发时刻会有抖动（部署/重试），刚过 24 小时就报警
 *      会把"晚了几分钟"报成"一天没跑"。
 */
export const DAILY_STALL_HOURS = 26;

/**
 * `job_runs` 里"每日作业"那一行的名字。
 * @why 与端点（`internal-jobs-routes.ts` 传给 `createSchedulerDeps` 的 name）**同一个值**，
 *      所以端点改用它而不是再写一个 'daily' 字面量——两处字面量各自漂移时，
 *      看门狗会去盯一个不存在的行（静默失明，最坏的一类失效）。
 */
export const DAILY_JOB_ROW_NAME = 'daily';

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
       and (result in (${RESULT_LATE_PAYMENT}, ${RESULT_STATUS_CONFLICT})
            or result like ${RESULT_MISMATCH_PREFIX + '%'}
            or result like ${RESULT_UNMATCHED_PREFIX + '%'})
     order by received_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from webhook_events
     where received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
       and (result in (${RESULT_LATE_PAYMENT}, ${RESULT_STATUS_CONFLICT})
            or result like ${RESULT_MISMATCH_PREFIX + '%'}
            or result like ${RESULT_UNMATCHED_PREFIX + '%'})
  `;
  return {
    key: 'callback_anomalies_48h',
    count: Number(countRows[0]?.count ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.event_id)),
  };
}

/**
 * 第五类：**卡住的回调**（KD-2，2026-09-28 测试审查实测）——登记了、处理中途失败或进程崩溃、
 * 租约早已过期、却**没有任何结果**（`processed_at is null`）的回调。
 *
 * @why pay-callback.ts 与 ports/webhooks.ts 都承诺这类行"由 F13 对账捞起"，而第三类只按 `result`
 *      取值扫——result 为空的行永远不会被列出。机构若不再重发（已达重试上限、或事件本就只发一次），
 *      这笔钱就静默躺着。这是"对账最该看见、却恰好看不见"的一类。
 * @why 条件用"租约已过期或从未取得"（`processing_until is null or < startedAt`）：
 *      租约还在的行是**正在处理**，不是卡住；只看 `processed_at is null` 会把正在跑的也报出来。
 * @limitation 与第三类同一个 48 小时回看窗口：更早的孤儿行会从报告里消失。
 *             作业每天一轮，每条孤儿行会被报告约两次；超过窗口仍未处理的，说明已被人看过两次仍放着，
 *             继续每天报它只会成为噪声（与第三类取窗口的理由相同）。
 */
async function scanUnfinishedCallbacks(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ event_id: string }[]>`
    select event_id from webhook_events
     where processed_at is null
       and (processing_until is null or processing_until < ${ctx.startedAt}::timestamptz)
       and received_at <= ${ctx.startedAt}::timestamptz
                          - make_interval(mins => ${UNFINISHED_CALLBACK_MINUTES})
       and received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
     order by received_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from webhook_events
     where processed_at is null
       and (processing_until is null or processing_until < ${ctx.startedAt}::timestamptz)
       and received_at <= ${ctx.startedAt}::timestamptz
                          - make_interval(mins => ${UNFINISHED_CALLBACK_MINUTES})
       and received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
  `;
  return {
    key: 'unfinished_callbacks',
    count: Number(countRows[0]?.count ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.event_id)),
  };
}

/**
 * 第四类：**调度器心跳停滞**（AJ-102 承诺落到这里，不是新增想法）。
 *
 * @why 契约 0.5.4 里删掉了 `/healthz` 的"调度看门狗"承诺（那会让 Render 把调度卡顿
 *      当成实例故障去杀进程），当时写下的替代方案就是"**转交 I1 的 daily 对账 job**
 *      ——tick/daily 互相看心跳，异常走 error 日志"。本函数就是那个替代方案。
 *      没有它，`job_runs` 那两行只在"有人想起来去查"时才被看见。
 * @why 判据是 `last_success_at`（不是 `updated_at`）：失败轮次只更新 last_error、
 *      不动 last_success_at（清单 F13），所以"一直在失败"表现为**成功时间停滞**，
 *      用 updated_at 会把它误判成健康。
 *
 * @limitation **daily 行的 null 刻意不算停滞**：本 job 自己就是 daily，
 *      它此刻还没写完自己的心跳（写完在事务提交时），把 null 当停滞意味着
 *      "第一次跑必定报警"。tick 没有这个豁免——常驻调度器起不来是真故障。
 */
async function scanStalledHeartbeats(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const stalled = await ctx.tx<{ name: string }[]>`
    select name from job_runs
     where (
             name = ${TICK_JOB_NAME}
             and (last_success_at is null
                  or last_success_at < ${ctx.startedAt}::timestamptz
                                       - make_interval(mins => ${TICK_STALL_MINUTES}))
           )
        or (
             name = ${DAILY_JOB_ROW_NAME}
             and last_success_at is not null
             and last_success_at < ${ctx.startedAt}::timestamptz
                                    - make_interval(hours => ${DAILY_STALL_HOURS})
           )
     order by name
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  const countRows = await ctx.tx<{ count: string }[]>`
    select count(*)::text as count from job_runs
     where (
             name = ${TICK_JOB_NAME}
             and (last_success_at is null
                  or last_success_at < ${ctx.startedAt}::timestamptz
                                       - make_interval(mins => ${TICK_STALL_MINUTES}))
           )
        or (
             name = ${DAILY_JOB_ROW_NAME}
             and last_success_at is not null
             and last_success_at < ${ctx.startedAt}::timestamptz
                                    - make_interval(hours => ${DAILY_STALL_HOURS})
           )
  `;
  return {
    key: 'stalled_heartbeats',
    count: Number(countRows[0]?.count ?? 0),
    ids: stalled.slice(0, RECONCILE_IDS_CAP).map((r) => String(r.name)),
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
        await scanStalledHeartbeats(ctx),
        await scanUnfinishedCallbacks(ctx),
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
