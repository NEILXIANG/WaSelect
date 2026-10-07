/**
 * 职责：`order_refunds`（部分退款，迁移 030 / AJ-383）的仓储。
 *
 * @why 额度求和与"在途"判定只有这一处：路由在**订单行锁内**调 `sumPartialRefunds`，
 *      判定与插入同一事务——锁序先 orders 后 order_refunds，与整单退款同一把锁，
 *      所以"部分退款"与"整单退款"互相看得见对方（不会一边在途、另一边照常发起）。
 * @why 状态推进只能从非终态出发（`settlePartialRefund` 的 WHERE）：重放的同步请求、并发的两次点击，
 *      都不能把 succeeded 改回 pending，或把 failed 改成 succeeded。
 * @limitation 不写 order_events：事件由调用方在落定后写（只有调用方知道 actor 与是否是"这次"落定的）。
 *
 * @see migrations/030_order_refunds.sql；domain/partial-refund.ts；app/partial-refund.ts
 */
import type { Db } from './db.js';

export type PartialRefundStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface PartialRefundInsert {
  id: string;
  orderId: string;
  paymentId: string;
  currency: string;
  amountMinor: number;
  reason: string;
  actor: string;
}

export interface PartialRefundRow {
  id: string;
  payment_id: string;
  currency: string;
  amount_minor: number;
  reason: string;
  status: PartialRefundStatus;
  provider_ref: string | null;
  actor: string;
  created_at: Date;
  settled_at: Date | null;
}

export async function insertPartialRefund(tx: Db, r: PartialRefundInsert): Promise<void> {
  await tx`
    insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor)
    values (${r.id}, ${r.orderId}, ${r.paymentId}, ${r.currency}, ${r.amountMinor}, ${r.reason},
            'initiated', ${r.actor})
  `;
}

/** 额度口径：failed 以外都占额度（在途的可能已经退出去了）；inFlight = 有 initiated / pending / unknown。 */
export async function sumPartialRefunds(
  tx: Db,
  orderId: string,
): Promise<{ reservedMinor: number; succeededMinor: number; inFlight: boolean }> {
  const [r] = await tx`
    select coalesce(sum(amount_minor) filter (where status <> 'failed'), 0)     as reserved,
           coalesce(sum(amount_minor) filter (where status = 'succeeded'), 0)   as succeeded,
           count(*) filter (where status in ('initiated', 'pending', 'unknown')) as in_flight
      from order_refunds where order_id = ${orderId}
  `;
  return {
    reservedMinor: Number(r?.['reserved'] ?? 0),
    succeededMinor: Number(r?.['succeeded'] ?? 0),
    inFlight: Number(r?.['in_flight'] ?? 0) > 0,
  };
}

/**
 * 推进状态。只从 initiated / pending / unknown 出发；返回 true = 这次改动生效（调用方据此决定写不写事件）。
 * @why `provider_ref` 传 null 时保留原值：结果未知（unknown）那一刻没有单号，不能把 pending 时记下的单号抹掉。
 * @why 只有 succeeded / failed 写 `settled_at`：pending / unknown 还没落定。
 */
export async function settlePartialRefund(
  db: Db,
  id: string,
  status: Exclude<PartialRefundStatus, 'initiated'>,
  providerRef: string | null,
  at: Date,
): Promise<boolean> {
  const final = status === 'succeeded' || status === 'failed';
  const rows = await db`
    update order_refunds
       set status = ${status},
           provider_ref = coalesce(${providerRef}, provider_ref),
           settled_at = ${final ? at : null}
     where id = ${id} and status in ('initiated', 'pending', 'unknown')
  `;
  return rows.count > 0;
}

/** 管理端详情用：按发起顺序。 */
export async function listPartialRefunds(db: Db, orderId: string): Promise<PartialRefundRow[]> {
  const rows = await db`
    select id, payment_id, currency, amount_minor, reason, status, provider_ref, actor, created_at, settled_at
      from order_refunds where order_id = ${orderId}
     order by created_at, id
  `;
  return rows.map((r) => ({
    id: String(r['id']),
    payment_id: String(r['payment_id']),
    currency: String(r['currency']),
    amount_minor: Number(r['amount_minor']),
    reason: String(r['reason']),
    status: String(r['status']) as PartialRefundStatus,
    provider_ref: r['provider_ref'] === null ? null : String(r['provider_ref']),
    actor: String(r['actor']),
    created_at: r['created_at'] as Date,
    settled_at: (r['settled_at'] as Date | null) ?? null,
  }));
}
