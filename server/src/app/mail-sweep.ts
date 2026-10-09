/**
 * 职责：daily 补发漏发的订单通知邮件（E-1，工程分析 2026-10-08 / AJ-419）。
 *
 * @why 事件总线进程内、发后不等（adapters/event-bus.ts @limitation 一/二）：提交后、发信前进程退出，那封信永远不会发；
 *      而小程序订阅消息未做，邮件是买家**唯一**的主动通知。全量 outbox 要改每一处发事件的写路径，这里取最小版：
 *      以订单 / 退款的**事实**（paid_at / shipped_at / refunded_at / order_refunds.settled_at）反查
 *      "该有 sent 记录却没有"的，**重新发出原事件**——发信、模板、幂等键、发信记录全部复用 order-mail.ts，
 *      本作业不认识邮件服务。
 * @why 重发事件而不是直接发信：幂等键与实时路径同一个（`事件:订单[:子键]`），服务商侧去重、`mail_deliveries` 落同一行。
 * @why 三道闸：
 *      ① **首次部署守卫**——表里一条记录都没有时一封不补（上线前的单都"没有记录"，补了就是重复邮件）；
 *         之后只补发生时刻 ≥ 最早一条记录的事件（"记录从什么时候开始有"）。
 *      ② **窗口**——只看最近 48 小时；更早的漏发人工处理（买家多半已经在订单页看到状态了）。
 *      ③ **宽限**——发生不满 10 分钟的不补：实时路径可能还在途（daily 偶尔与实时同时到，见 order-mail.ts record 的 @why）。
 *      没留邮箱的根本不进候选。
 *      失败上限 MAIL_SWEEP_MAX_ATTEMPTS = 5 **实际不会触发**（统一结论 5.7 订正原"最多补到第 5 次"）：
 *      48 小时窗口 + 每天一次 ⇒ 一件事实最多赶上 2 轮补发，连实时那次共 3 次。上限留作作业改成更频繁时的保险。
 * @why 放弃留痕（AJ-426）：出了窗口仍没有 sent 记录 = 系统不再尝试；由对账第十三类（daily-reconciliation.ts
 *      `scanOrderMailUnsent`）报出来，运营换渠道联系买家。候选口径共用 {@link mailFacts}，两边不会分叉。
 * @limitation 一：部分退款退满后只发了整单退款那封（partial-refund.ts），所以"单已退满"的部分退款行不补——
 *              退满之前漏掉的那几封部分退款信补不回来；整单退款信会补。
 * @limitation 二：改运单号后的重发（`mail_key`，AJ-386）不补——补发只认首封发货信的键。
 * @limitation 三：补的是"没成功交给服务商"的；交给服务商之后的退信 / 进垃圾箱看不见（resend.ts @limitation）。
 * @limitation 四：单轮上限 MAIL_SWEEP_BATCH_LIMIT，积压分多天消化（与 AUTO_ADVANCE_BATCH_LIMIT 同口径）。
 * @see app/order-mail.ts（发信与记录）；migrations/037_mail_deliveries.sql
 */
import type { Db } from '../adapters/db.js';
import { plusMs } from '../adapters/clock.js';
import type { JobContext, JobOutcome, SchedulerJob } from '../ports/scheduler.js';

export const MAIL_SWEEP_JOB = 'mail_sweep';
/** 只补最近这么多小时内发生的（@why ②）。 */
export const MAIL_SWEEP_WINDOW_HOURS = 48;
/** 发生不满这么多分钟的不补（@why ③）。 */
export const MAIL_SWEEP_GRACE_MINUTES = 10;
/** 失败最多补到第几次（含实时那一次）；现行窗口与频率下实际不会触发，见文件头 @why ③ 之后的订正。 */
export const MAIL_SWEEP_MAX_ATTEMPTS = 5;
/** 单轮最多补几封（@limitation 四）。 */
export const MAIL_SWEEP_BATCH_LIMIT = 200;

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** 一条要补的信：事件名 + 订单 + 子键（部分退款的 refund_id）。 */
interface Pending {
  tag: string;
  order_id: string;
  sub: string | null;
}

/**
 * "该发信"的四类事实：发生时刻 ∈ [from, to)、留了邮箱、且不早于首条发信记录（@why ① 首次部署守卫）。
 * 列：tag、order_id、sub（部分退款的 refund_id）、at、key（= order-mail.ts 的幂等键 `事件:订单[:子键]`）。
 * @why 补发作业与对账第十三类共用（AJ-426）：口径各写一份，"补发认为该发、对账认为不该发"会悄悄分叉。
 * @why 半开区间：对账的报告带以补发窗口的下沿为上界，闭区间会让正好落在下沿的那一刻两边都算。
 * @why 地板写成 `at >= (select min(first_at) …)`：表空时右边是 null、比较结果为 null，一行都不出——守卫不用另写分支。
 */
export function mailFacts(tx: Db, from: Date, to: Date) {
  return tx`
    select f.*, f.tag || ':' || f.order_id || coalesce(':' || f.sub, '') as key
      from (
        select 'order.paid' as tag, o.id as order_id, null::text as sub, o.paid_at as at
          from orders o
         where o.paid_at >= ${from} and o.paid_at < ${to} and coalesce(o.contact_email, '') <> ''
        union all
        select 'order.shipped', o.id, null, o.shipped_at
          from orders o
         where o.shipped_at >= ${from} and o.shipped_at < ${to} and coalesce(o.contact_email, '') <> ''
        union all
        select 'order.refunded', o.id, null, o.refunded_at
          from orders o
         where o.status = 'refunded' and o.refunded_at >= ${from} and o.refunded_at < ${to}
           and coalesce(o.contact_email, '') <> ''
        union all
        select 'order.partially_refunded', r.order_id, r.id, r.settled_at
          from order_refunds r join orders o on o.id = r.order_id
         where r.status = 'succeeded' and r.settled_at >= ${from} and r.settled_at < ${to}
           and o.status <> 'refunded' and coalesce(o.contact_email, '') <> ''
      ) f
     where f.at >= (select min(first_at) from mail_deliveries)`;
}

export function createMailSweepJob(): SchedulerJob<Db> {
  return {
    name: MAIL_SWEEP_JOB,
    run: async (ctx: JobContext<Db>): Promise<JobOutcome> => {
      const from = plusMs(ctx.startedAt, -MAIL_SWEEP_WINDOW_HOURS * HOUR_MS);
      const to = plusMs(ctx.startedAt, -MAIL_SWEEP_GRACE_MINUTES * MIN_MS);
      // 候选 = 四类"该发信"的事实；每支都先按窗口过滤（订单量大时能走时间列）
      const rows = await ctx.tx<Pending[]>`
        select c.tag, c.order_id, c.sub
          from (${mailFacts(ctx.tx, from, to)}) c
          left join mail_deliveries d on d.idempotency_key = c.key
         where d.idempotency_key is null
            or (d.status = 'failed' and d.attempts < ${MAIL_SWEEP_MAX_ATTEMPTS})
         order by c.at, c.order_id
         limit ${MAIL_SWEEP_BATCH_LIMIT}`;
      for (const r of rows) {
        ctx.emit({
          name: r.tag,
          at: ctx.startedAt.toISOString(),
          orderId: r.order_id,
          ...(r.sub === null ? {} : { payload: { refund_id: r.sub } }),
        });
      }
      ctx.log.info('mail_sweep_resent', {
        result: 'ok',
        count: rows.length,
        ctx: {
          window_hours: MAIL_SWEEP_WINDOW_HOURS,
          grace_minutes: MAIL_SWEEP_GRACE_MINUTES,
          batch_limit: MAIL_SWEEP_BATCH_LIMIT,
        },
      });
      return { processed: rows.length };
    },
  };
}
