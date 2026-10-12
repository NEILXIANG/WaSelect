/**
 * 职责：**每日对账 job**（I1-U7b，欠账① / D-45）——把"需要人工看一眼"的各类异常
 *       扫出来，计数 + 取样落日志。
 *       ⚠️ 类数随发现而增长（当前七类，①–⑦ 列在下面），**不要再从这里的措辞推断有几类**——
 *          文件头曾长期写"三类"而实际已有六类，照它读的人会以为清单到此为止（§2 第 88 条）。
 *
 * @why 只**报告**不自动修：三类异常的处置都是"人看了再定"——
 *      ① initiated 支付行挂在已关闭的单上（D-50 连带作废 best-effort 失败的残留）：
 *         钱没扣，但支付行悬着，机构侧会话可能还活着；
 *      ② 订单 paid 但最近一条 payments 不是 succeeded（两本账不符）：
 *         mark-paid 设计上是同事务封口，出现即意味着有未知写路径；
 *      ③ 近 48h 回调登记为 late_payment / mismatch:* / ignored:status_conflict / unmatched:*（词表 app/webhook-results.ts）：
 *         "钱扣了但不能发货"与"钱到了找不到单"，每一条都要人工跟进；
 *      ④ 调度器心跳停滞（AJ-102 的替代方案）；
 *      ⑤ 卡住的回调：登记了却没有任何结果、租约已过期（KD-2 / AJ-175，见 scanUnfinishedCallbacks）；
 *      ⑥ 退款滞留：订单停在 refunding 超过 24 小时（F-03 / AJ-178，见 scanStuckRefunds）；
 *      ⑧ 部分退款滞留：order_refunds 在途超过 24 小时（AJ-383，见 scanStuckPartialRefunds）；
 *      ⑦ 审核模式仍在生产开启：临到期或已过期（A7 / AJ-378，见 reviewWindowAnomaly）；
 *      ⑪ 迟到付款未退：钱已扣、订单已关，尚未退款（AJ-425，不设回看上界，见 scanLatePaidUnrefunded）；
 *      ⑫ 售后申请等待：提交超过 24 小时仍在 open / processing（AJ-425，见 scanAfterSalesWaiting）；
 *      ⑬ 买家通知邮件已放弃：出了 48 小时补发窗口仍没有发出记录（AJ-426，见 scanOrderMailUnsent）；
 *      ⑭ 上线配置缺项：运费表空 / 缺汇率 / 审核商品不可下单（空库上线演练 2026-10-12，见 scanLaunchReadiness；只在 staging / production）。
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
 * @limitation 二：**只读业务表**（不改任何业务行；唯一的写是追加一行 reconciliation_runs，剩余清单 3-2）。对账 job 在事务里跑只是为了共用框架的
 *              锁与心跳；它发现的问题一律靠人去修，不在事务里顺手改数据。
 * @limitation 三：各类是**不同视角，不是互斥集合**——同一行可以同时命中多类
 *              （典型：订单 paid 但支付行仍 initiated，既是①悬空支付、又是②两本账不符）。
 *              于是 `processed` 是**异常条数之和**，不是"有问题的行数"，更不是异常类数；
 *              读它时不要以为 4 条 = 4 个不同的问题。
 *
 * @see app/internal-jobs-routes.ts（触发端点）；app/expire-orders.ts（同一框架的兄弟 job）
 */
import { AFTER_SALE_OPEN_STATUSES } from '@waselect/shared';
import type { Db } from '../adapters/db.js';
import { insertReconciliationRun } from '../adapters/ops-log.js';
import { plusMs } from '../adapters/clock.js';
import { MAIL_SWEEP_WINDOW_HOURS, mailFacts } from './mail-sweep.js';
import {
  DAILY_JOB_ROW_NAME,
  DAILY_STALL_HOURS,
  TICK_JOB_NAME,
  type JobContext,
  type JobOutcome,
  type SchedulerJob,
} from '../ports/scheduler.js';
import { daysUntil, REVIEW_WINDOW_WARN_DAYS, utcDay } from '../review-window.js';
import {
  RESULT_IGNORED_PREFIX,
  RESULT_LATE_PAYMENT,
  RESULT_MISMATCH_PREFIX,
  RESULT_STATUS_CONFLICT,
  RESULT_UNMATCHED_PREFIX,
} from './webhook-results.js';
import type { Logger } from '../logger.js';

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
 * 退款滞留阈值（小时）：订单进入 refunding 超过这么久仍未落定 → 报 stuck_refunds（F-03，AJ-178）。
 * @why 24 小时：与机构幂等键的缓存窗口同量级（Stripe 缓存执行结果 24h，KD-4 的 @measured）——
 *      到这个时刻"同键重试拿回首次结果"这条自愈路径已经走完，仍在 refunding 的单必然要人看。
 *      取更短（如 1 小时）会把"管理员刚点、机构还在处理"的正常单报出来。
 *      （买家多久到账是发卡行的事，与退款对象的状态无关，不拿来当阈值。）
 */
export const STUCK_REFUND_HOURS = 24;

/** 售后申请等待阈值（小时）：提交超过这么久仍未结案 → 报 after_sales_waiting（AJ-425）。 */
export const AFTER_SALE_WAITING_HOURS = 24;
/** 第十三类的报告带宽度（小时）：出了补发窗口之后再报这么久（scanOrderMailUnsent @why）。 */
export const MAIL_UNSENT_REPORT_HOURS = 48;

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

interface AnomalyClass {
  /** 日志键与报告键（英文蛇形：日志检索口径）。 */
  key: string;
  count: number;
  /** 取样 id（≤ RECONCILE_IDS_CAP）；count > ids.length 即"还有更多"。 */
  ids: string[];
}

/**
 * 把"取样行 + 窗口计数"收成 {@link AnomalyClass} 的**计数与取样**两半。
 *
 * @why 判据（WHERE）**只能出现一份**：本文件的六类扫描此前都是
 *      「`select … where … limit N+1`」+「`select count(*) … where …`」**两条 SQL**，
 *      于是同一个 WHERE 被写两遍。这正是 `adapters/risk-admin.ts` 文件头
 *      `@limitation 一` 明令禁止的形态（"判据出现两份，改一处漏一处"）——
 *      而它在本文件里**六处全中**，且判据最长的一类（卡住的回调）有四个条件。
 *      漂移的后果特别适合本文件：**对账是"两本账不符"的唯一发现机制**，
 *      漏报表现为"报告说 0 条异常"，而真相是"有一处条件没被改到"——
 *      "没有新闻"恰好也是"一切正常"的样子，于是失效完全不可见。
 *
 * @why 收成 `count(*) over ()` **一条语句**而不是把 WHERE 抽成常量再拼两条 SQL：
 *      后者判据只剩一份（解决了漂移），但两条语句在 READ COMMITTED 下
 *      各拿一个快照——计数与取样仍可能来自两个时刻（中间来了新回调，
 *      报告会说"共 5 条"却只列得出 3 条 id）。窗口函数与取样在**同一条语句**里，
 *      两者必然同快照。
 *      ⚠️ `count(*) over ()` 在 `limit` **之前**求值，所以 `total` 是满足 WHERE 的
 *      全部行数（不受取样截断影响）——这是本函数成立的前提，由用例钉住。
 *
 * @param rows 取样行（`limit RECONCILE_IDS_CAP + 1`，含 `total` 列）
 * @param idKey 取样列的名字（多数是 `id`，心跳那类是 `name`）
 */
function toAnomaly(
  rows: readonly Record<string, unknown>[],
  idKey = 'id',
): { count: number; ids: string[] } {
  return {
    count: Number(rows[0]?.['total'] ?? 0),
    ids: rows.slice(0, RECONCILE_IDS_CAP).map((r) => String(r[idKey])),
  };
}

async function scanDanglingPayments(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select p.id, count(*) over ()::text as total
      from payments p
      join orders o on o.id = p.order_id
     where p.status = 'initiated'
       and o.status not in ('created', 'pending_payment')
     order by p.created_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return {
    key: 'dangling_initiated_payments',
    ...toAnomaly(rows),
  };
}

async function scanLedgerMismatch(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select o.id, count(*) over ()::text as total
      from orders o
     where o.status = 'paid'
       -- 判"有没有一笔 succeeded"，不判"最新一行是不是 succeeded"（第三轮缺口 P2-10，AJ-385）：
       -- 并发换通道时被作废的旧行 created_at 反而更晚，取最新一行会把正常已付单误报成没收到钱
       and not exists (
         select 1 from payments p where p.order_id = o.id and p.status = 'succeeded'
       )
     order by o.id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return {
    key: 'paid_without_succeeded_payment',
    ...toAnomaly(rows),
  };
}

async function scanCallbackAnomalies(ctx: JobContext<Db>): Promise<AnomalyClass> {
  // ⚠️ 窗口下界在 SQL 里算（`startedAt - make_interval`），不在 JS 里 new Date——
  //    F10 禁业务侧 new Date：判定基准必须全部来自注入时钟（ctx.startedAt）
  const rows = await ctx.tx<{ event_id: string; total: string }[]>`
    select event_id, count(*) over ()::text as total
      from webhook_events
     where received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
       and (result in (${RESULT_LATE_PAYMENT}, ${RESULT_STATUS_CONFLICT})
            or result like ${RESULT_MISMATCH_PREFIX + '%'}
            or result like ${RESULT_UNMATCHED_PREFIX + '%'})
     order by received_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return {
    key: 'callback_anomalies_48h',
    ...toAnomaly(rows, 'event_id'),
  };
}

/**
 * 第十类：**汇率快过期**（第三轮缺口 P1-9，AJ-385）。
 * @why 汇率超过 `FX_MAX_AGE_HOURS` 未更新就当作缺失、整店 50003（剩余清单 1-2），这是对的保护；
 *      但此前**没有任何预警**：`fx_rate_stale` 只在有人报价时打，周五录、周一早上已停售一整夜。
 *      对账每天跑，提前一天报（默认 72−24=48h），跟着告警邮件 / Sentry 走。
 * @why 样本是币种代码而不是行 id：运营要做的动作是"去录这个币"，不是"去看哪一行"。
 * @limitation 每日一次：48h 阈值保证在真正停售前至少被报一次；更细的粒度要靠报价时的 `fx_rate_stale`。
 */
async function scanFxRateAging(ctx: JobContext<Db>, warnAfterHours: number): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select quote as id, count(*) over ()::text as total
      from (
        select quote, max(effective_from) as latest
          from fx_rates
         where effective_from <= ${ctx.startedAt}::timestamptz
         group by quote
      ) f
     where f.latest <= ${ctx.startedAt}::timestamptz - make_interval(hours => ${warnAfterHours})
     order by quote
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'fx_rate_aging', ...toAnomaly(rows) };
}

/**
 * 第九类：**机构侧退款、本地无记录**（第三轮缺口 P1-4，AJ-385）。
 * @why `charge.refunded` 等退款事件没有落账器（F12 未做），登记为 `ignored:refunded` 后就再没人看——
 *      运营在 Stripe 后台手退一次（运维手册禁止，但人会犯），本地订单仍 paid / shipped，可再发货、可再退一次。
 *      我们自己发起的退款也会产生这类事件，所以只报"本地既不在 refunding / refunded、也没有任何非失败部分退款"的。
 * @why 订单号取自 note 前缀 `order:<id> `（pay-callback.ts 写入）：webhook_events 没有 order_id 列，
 *      为一个对账类加列不值；前缀格式由 pay-routes 单测钉住。
 * @limitation 与第三类同一个 48 小时回看窗口；只是**报出**，不落账（落账要等 F12 实测退款事件载荷）。
 */
async function scanProviderRefundUnrecorded(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select w.order_id as id, count(*) over ()::text as total
      from (
        select distinct substring(note from '^order:([^ ]+) ') as order_id
          from webhook_events
         where result = ${RESULT_IGNORED_PREFIX + 'refunded'}
           and received_at > ${ctx.startedAt}::timestamptz
                             - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
      ) w
      join orders o on o.id = w.order_id
     where o.status not in ('refunding', 'refunded')
       and not exists (
         select 1 from order_refunds r where r.order_id = o.id and r.status <> 'failed'
       )
     order by w.order_id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'provider_refund_unrecorded', ...toAnomaly(rows) };
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
  const rows = await ctx.tx<{ event_id: string; total: string }[]>`
    select event_id, count(*) over ()::text as total
      from webhook_events
     where processed_at is null
       and (processing_until is null or processing_until < ${ctx.startedAt}::timestamptz)
       and received_at <= ${ctx.startedAt}::timestamptz
                          - make_interval(mins => ${UNFINISHED_CALLBACK_MINUTES})
       and received_at > ${ctx.startedAt}::timestamptz
                          - make_interval(hours => ${RECONCILE_LOOKBACK_HOURS})
     order by received_at
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return {
    key: 'unfinished_callbacks',
    ...toAnomaly(rows, 'event_id'),
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
  const stalled = await ctx.tx<{ name: string; total: string }[]>`
    select name, count(*) over ()::text as total
      from job_runs
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
  return {
    key: 'stalled_heartbeats',
    ...toAnomaly(stalled, 'name'),
  };
}

/**
 * 第六类：**退款滞留**（F-03，AJ-178）——订单停在 refunding 超过 STUCK_REFUND_HOURS。
 *
 * @why refunding 是"钱在路上"的状态：机构回 pending、机构报错后同键重试拿回同一个错误、
 *      或有人在机构后台手工退了款——这几种情况订单都会停在这里，而买家看到的一直是"退款中"。
 *      此前五类扫描都不看它（独立审查辨析 §3.1 ④）。
 * @why 起点取**最近一次进入 refunding 的事件时刻**（注入时钟写的业务时间），缺事件时退回 `orders.updated_at`：
 *      updated_at 由库的 now() 写，任何无关更新都会刷新它，单用它会把老单"洗新"。
 * @why **不设回看上界**（与第三、五类不同）：滞留的退款是**活的欠款**，每一张都对应一个等钱的买家，
 *      落定之前每天都该报，报到有人处理为止。
 */
async function scanStuckRefunds(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select o.id, count(*) over ()::text as total
      from orders o
     where o.status = 'refunding'
       and coalesce(
             (select max(e.at) from order_events e
               where e.order_id = o.id and e.status = 'refunding'),
             o.updated_at
           ) <= ${ctx.startedAt}::timestamptz - make_interval(hours => ${STUCK_REFUND_HOURS})
     order by o.id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return {
    key: 'stuck_refunds',
    ...toAnomaly(rows),
  };
}

/**
 * 第十一类：**迟到付款未退**（AJ-425，统一结论 5.1）——有 `late_paid` 事件、订单不在退款中 / 已退款。
 * @why 第三类只回看 48 小时，迟到付款在那之后就再也不会被报出；而它是"钱已扣、承诺原路退回"的单，必须有人去退。
 *      所以本类**不设回看上界**：退掉之前每天都报。
 */
async function scanLatePaidUnrefunded(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select o.id, count(*) over ()::text as total
      from orders o
     where o.status not in ('refunding', 'refunded')
       and exists (select 1 from order_events e where e.order_id = o.id and e.status = 'late_paid')
     order by o.id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'late_paid_unrefunded', ...toAnomaly(rows) };
}

/**
 * 第十二类：**售后申请等待**（AJ-425）——提交超过 AFTER_SALE_WAITING_HOURS 仍在 open / processing。
 * @why 买家提交售后后运营没有任何推送；待办条能看见，但没人打开后台时只有对账（告警邮件 / Sentry）会响。
 * @why 样本给订单 id（运营按单处理），起点取 `created_at`（提交时刻），"处理中"不算重新计时——它仍然是买家在等。
 */
async function scanAfterSalesWaiting(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ order_id: string; total: string }[]>`
    select a.order_id, count(*) over ()::text as total
      from after_sale_requests a
     where a.status in ${ctx.tx([...AFTER_SALE_OPEN_STATUSES])}
       and a.created_at <= ${ctx.startedAt}::timestamptz - make_interval(hours => ${AFTER_SALE_WAITING_HOURS})
     order by a.order_id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'after_sales_waiting', ...toAnomaly(rows, 'order_id') };
}

/**
 * 第十三类：**买家通知邮件已放弃**（AJ-426，统一结论 5.1）——发生时刻落在 [startedAt − 96h, startedAt − 48h)、
 * 仍没有 sent 记录（没有记录，或最后一次是 failed）的"该发信"事实。样本是幂等键（`事件:订单[:子键]`，不含邮箱）。
 * @why 补发作业只看最近 48 小时，出了窗口就不再尝试；原先这一步不留任何痕迹，运营不知道哪位买家没收到通知。
 * @why 报告带取 48 小时宽（每封约报两天）：daily 偶尔漏跑一天也不丢；不设成"一直报"——邮件补不回来，
 *      运营换渠道联系过之后没有可以"结案"的动作，一直报只会变成噪声。
 * @why `skipped`（没配邮件服务，只记了日志）不算放弃：那是开发 / 审核期的预期行为。
 * @limitation 连续漏跑超过两天时，带外的那几封不会再报。
 */
async function scanOrderMailUnsent(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const from = plusMs(
    ctx.startedAt,
    -(MAIL_SWEEP_WINDOW_HOURS + MAIL_UNSENT_REPORT_HOURS) * 3_600_000,
  );
  const to = plusMs(ctx.startedAt, -MAIL_SWEEP_WINDOW_HOURS * 3_600_000);
  const rows = await ctx.tx<{ key: string; total: string }[]>`
    select c.key, count(*) over ()::text as total
      from (${mailFacts(ctx.tx, from, to)}) c
      left join mail_deliveries d on d.idempotency_key = c.key
     where d.idempotency_key is null or d.status = 'failed'
     order by c.key
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'order_mail_unsent', ...toAnomaly(rows, 'key') };
}

/**
 * 第八类：**部分退款滞留**（AJ-383）——`order_refunds` 里 initiated / pending / unknown 超过 24 小时。
 * @why 部分退款**不改订单状态**，所以第六类（看 orders.status = refunding）永远看不见它；
 *      停在在途的那一笔还占着额度、挡着下一笔，买家在等钱。与第六类同阈值、同"不设回看上界"口径。
 * @why 起点取 `created_at`（登记时刻）：在途期间这一行不会被别的流程刷新，不存在"被洗新"的问题。
 */
async function scanStuckPartialRefunds(ctx: JobContext<Db>): Promise<AnomalyClass> {
  const rows = await ctx.tx<{ id: string; total: string }[]>`
    select r.id, count(*) over ()::text as total
      from order_refunds r
     where r.status in ('initiated', 'pending', 'unknown')
       and r.created_at <= ${ctx.startedAt}::timestamptz - make_interval(hours => ${STUCK_REFUND_HOURS})
     order by r.id
     limit ${RECONCILE_IDS_CAP + 1}
  `;
  return { key: 'stuck_partial_refunds', ...toAnomaly(rows) };
}

/**
 * 第七类：**审核模式仍在生产开启**（A7 / AJ-378）——临到期或已过期时报一条。
 *
 * @why 启动闸门（`config.ts` 规则 2f）只能拦"**启动那一刻**已过期"：
 *      一个跑起来之后就再没重启过的进程（审核期最常见的形态——没人发版、没人改配置），
 *      截止日过了它照样在服务，假单照常产生，而闸门一次都没机会跑。
 *      每日对账是唯一每天都会执行的作业，把它挂在这里，"过期"这件事**至少每天被说一次**。
 * @why 与前六类不同：这一类**不查库**——它是配置层的事实。判据因此写成纯函数并在单测里直接钉住，
 *      不用为了它去造数据。
 * @why 只在**最后 {@link REVIEW_WINDOW_WARN_DAYS} 天或已过期**时响，不是"开着就报"：
 *      审核期通常一两周，天天报同一句话会让人把告警当噪音关掉——
 *      而"人把告警关掉"比"晚三天发现"贵得多
 *      （`app/daily-heartbeat-watch.ts` @limitation 二 是同一条教训）。
 * @limitation 一：报出**不等于**停掉——本类只报告，不自动关审核模式。
 *              关掉它意味着切换支付通道，那是运维动作，且配错了方向（提前切真实通道）比晚切更糟。
 * @limitation 二：`on` 且 `until` 缺失这一支在生产**不可达**（启动闸门 2d 会先拒），
 *              留着它是因为一旦将来有人放宽了闸门，这一支会立刻报出"连截止日都没有"，
 *              而不是让整类检查静默失明。
 */
export function reviewWindowAnomaly(input: {
  /** 是否为"**生产** + `REVIEW_MODE=on`"；由装配处判定后传入，本函数不认识 config。 */
  on: boolean;
  /** `REVIEW_MODE_UNTIL`（可能未配）。 */
  until: string | undefined;
  /** "今天"（UTC 日历日，由 `ctx.startedAt` 推出——F10：时间只从外面进来）。 */
  todayUtc: string;
}): { key: string; count: number; ids: string[] } {
  if (!input.on) return { key: 'review_mode', count: 0, ids: [] };
  if (input.until === undefined) {
    return { key: 'review_mode_no_deadline', count: 1, ids: [] };
  }
  const left = daysUntil(input.todayUtc, input.until);
  if (left < 0) {
    return { key: 'review_mode_expired', count: 1, ids: [`${input.until}(已过${-left}天)`] };
  }
  if (left <= REVIEW_WINDOW_WARN_DAYS) {
    return { key: 'review_mode_closing', count: 1, ids: [`${input.until}(剩${left}天)`] };
  }
  return { key: 'review_mode', count: 0, ids: [] };
}

/**
 * 上线就绪检查的入参（只在 staging / production 由装配处传入；开发与测试库的运费表常是空的，报了只是噪音）。
 */
export interface LaunchReadinessInput {
  /** 要求有汇率的币种（`DISPLAY_CURRENCIES` 去掉 JPY）。 */
  fxQuotes: readonly string[];
  /** 审核期的审核商品 id；不在审核期传 null。 */
  reviewSkuId: string | null;
  /** 判"已生效"的时刻（汇率 effective_from ≤ 它）。 */
  at: Date;
}

/**
 * 第十四类：**上线配置缺项**（空库上线演练 2026-10-12）——买家此刻能不能下单的三项前提。
 * @why 全新库里运费表与汇率表都是空的，审核商品 id 又得在建商品之前写进环境变量：三者任何一项没配好，
 *      买家都下不了单（报价 50004「运费不可计算」/ 没有美元汇率银行卡无法发起 / 审核期唯一能下单的商品不存在），
 *      而启动、对账、设置页原先都不报，要等审核员或买家撞上——审核期撞上就是被拒审。
 * @why 取样写**人话**而不是 id（与审核模式那类同口径）：这类没有"行"可列，要说的是"缺什么、后果是什么"。
 * @why 同一函数也在启动时跑一次（main.ts）：部署后第一眼就能在日志 / Sentry 看到，不用等到凌晨对账。
 * @limitation 只查"有没有"，不查"对不对"（运费档是否覆盖到最重的商品、汇率是否合理由各自的校验与对账类管）。
 */
/**
 * 配置 → 就绪检查入参（对账端点与启动检查共用；只取三个字段，本文件仍不认识整份 config）。
 */
export function launchReadinessInput(c: {
  DISPLAY_CURRENCIES: readonly string[];
  REVIEW_MODE: string;
  REVIEW_SKU_ID?: string | undefined;
}): Omit<LaunchReadinessInput, 'at'> {
  return {
    fxQuotes: c.DISPLAY_CURRENCIES.filter((q) => q !== 'JPY'),
    reviewSkuId: c.REVIEW_MODE === 'on' ? (c.REVIEW_SKU_ID ?? null) : null,
  };
}

export async function scanLaunchReadiness(
  db: Db,
  input: LaunchReadinessInput,
): Promise<{ key: string; count: number; ids: string[] }> {
  const ids: string[] = [];
  const [rates] = await db<{ n: number }[]>`
    select count(*)::int as n from shipping_rates where active`;
  if ((rates?.n ?? 0) === 0) ids.push('运费表没有启用中的档位（买家报价一律"运费不可计算"）');
  const have = new Set(
    (
      await db<{ quote: string }[]>`
        select distinct quote from fx_rates where effective_from <= ${input.at}::timestamptz`
    ).map((r) => r.quote),
  );
  for (const q of [...input.fxQuotes].sort()) {
    if (have.has(q)) continue;
    ids.push(
      q === 'USD'
        ? `缺少 USD 汇率（商品不显示 USD 折算价，银行卡按美元收款无法发起）`
        : `缺少 ${q} 汇率（商品不显示 ${q} 折算价）`,
    );
  }
  if (input.reviewSkuId !== null) {
    const [p] = await db<{ title: string; status: string; stock: number }[]>`
      select title, status, stock from products where id = ${input.reviewSkuId}`;
    const tail = '（审核期只有它能下单）';
    if (p === undefined) ids.push(`审核商品 ${input.reviewSkuId} 不存在${tail}`);
    else if (p.status !== 'active') ids.push(`审核商品「${p.title}」没有上架${tail}`);
    else if (Number(p.stock) <= 0) ids.push(`审核商品「${p.title}」库存为 0${tail}`);
  }
  return { key: 'launch_not_ready', count: ids.length, ids: ids.slice(0, RECONCILE_IDS_CAP) };
}

/**
 * 启动时跑一次就绪检查并落日志：有缺项 → error `launch_not_ready`（进 Sentry）；齐了 → info `launch_ready`。
 * @why 部署后第一眼就要看到"还差什么"（空库上线演练 2026-10-12），而不是等凌晨的对账或第一位买家。
 * @why 检查自身失败只记 warn、不抛：它是提示，不能因为它让服务起不来。
 */
export async function reportLaunchReadiness(
  db: Db,
  logger: Pick<Logger, 'error' | 'info' | 'warn'>,
  input: LaunchReadinessInput,
): Promise<void> {
  try {
    const r = await scanLaunchReadiness(db, input);
    if (r.count > 0)
      logger.error('launch_not_ready', { result: 'not_ready', ctx: { issues: r.ids } });
    else logger.info('launch_ready', { result: 'ok' });
  } catch (e) {
    logger.warn('launch_readiness_check_failed', {
      result: 'failed',
      ctx: { reason: e instanceof Error ? e.message.slice(0, 200) : String(e) },
    });
  }
}

export function createDailyReconciliationJob(input: {
  /**
   * 审核模式是否在**生产**开启（`main` 侧按 `NODE_ENV` + `REVIEW_MODE` 判定后传入）。
   * @why 不传 config 进来：本 job 一旦认识 config，它就再也离不开装配根，
   *      而这里唯一需要的只是两个布尔/字符串——传最小事实，单测才能直接钉住判据。
   */
  reviewMode: { on: boolean; until: string | undefined };
  /**
   * 汇率"快过期"预警阈值（小时，P1-9）。装配处传 `FX_MAX_AGE_HOURS − 24`；不传 = 48（默认 72 的提前一天）。
   */
  fxWarnAfterHours?: number;
  /** 上线就绪检查（@see scanLaunchReadiness）；不传 = 不跑（开发 / 测试环境）。`at` 由本轮开始时刻给。 */
  launch?: Omit<LaunchReadinessInput, 'at'> | undefined;
}): SchedulerJob<Db> {
  return {
    name: DAILY_RECONCILIATION_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const classes = [
        await scanDanglingPayments(ctx),
        await scanLedgerMismatch(ctx),
        await scanCallbackAnomalies(ctx),
        await scanStalledHeartbeats(ctx),
        await scanUnfinishedCallbacks(ctx),
        await scanStuckRefunds(ctx),
        await scanStuckPartialRefunds(ctx),
        await scanLatePaidUnrefunded(ctx),
        await scanAfterSalesWaiting(ctx),
        await scanOrderMailUnsent(ctx),
        await scanProviderRefundUnrecorded(ctx),
        await scanFxRateAging(ctx, input.fxWarnAfterHours ?? 48),
        reviewWindowAnomaly({
          ...input.reviewMode,
          todayUtc: utcDay(ctx.startedAt),
        }),
        ...(input.launch === undefined
          ? []
          : [await scanLaunchReadiness(ctx.tx, { ...input.launch, at: ctx.startedAt })]),
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
      const counts = Object.fromEntries(classes.map((c) => [c.key, c.count]));
      // 剩余清单 3-2：每跑一次追加一行（零异常也写：运营要能看到"昨晚跑过、没问题"，而不是"不知道跑没跑"）
      await insertReconciliationRun(ctx.tx, {
        ranAt: ctx.startedAt,
        counts,
        samples: Object.fromEntries(classes.filter((c) => c.count > 0).map((c) => [c.key, c.ids])),
      });
      ctx.log.info('daily_reconciliation', {
        result: anomalies === 0 ? 'ok' : 'anomalies_found',
        ctx: counts,
      });
      // 剩余清单 2-4：有异常才发（提交后分发），运营告警邮件订阅它（app/ops-alert-mail.ts）
      if (anomalies > 0) {
        ctx.emit({
          name: 'reconciliation.anomalies_found',
          at: ctx.startedAt.toISOString(),
          payload: counts,
        });
      }
      return { processed: anomalies };
    },
  };
}
