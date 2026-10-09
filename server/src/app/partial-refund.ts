/**
 * 职责：部分退款的**第二段**——事务外调机构、按结果推进 `order_refunds` 的那一行（AJ-383）。
 *
 * 一笔部分退款 = 一行 = 一把机构幂等键（`refund-part:<id>`）。结果四种：
 *   ① succeeded → 行落定 + 事件 `partial_refunded`；
 *   ② pending   → 记单号，之后"同步"按单号查询；
 *   ③ failed（机构确认）→ 行 failed，**释放额度**（下一笔是新的一行、新的键）+ 事件 `partial_failed`（order_events.status 是 VARCHAR(20)，伪状态名须 ≤20 字）；
 *   ④ 抛错（超时 / 断连）→ 行 unknown：**仍占额度**（钱可能已经退出去了），之后"同步"用**同一把键**重放取回结果。
 *
 * @why ④ 必须与 ③ 分开（与整单退款 KD-4 同口径）：把"结果未知"当失败释放额度，下一笔换新键 ⇒ 可能退两次。
 * @why 熔断拒绝（CircuitOpenError）记 failed 而不是 unknown：熔断在出发前就拒了，请求**一次都没发出去**，
 *      钱不可能动；留着 unknown 反而会让这一笔永远占着额度、挡住下一笔。原样抛，保留"约 N ms 后重试"。
 * @why 部分退款不改订单状态、不回补库存、不发 `order.refunded`（那是整单退款的通知）。
 * @limitation 买家不会收到部分退款的邮件（订单邮件只订阅 paid / shipped / refunded 三个事件）——
 *             需要时客服另行告知；Stripe 自己的退款回执取决于 Dashboard 配置。已登记为后续项。
 * @limitation 不接机构退款回调，pending 靠管理员点"同步"或每日对账报出（与整单退款同口径，见 refund-execution.ts）。
 *
 * @see migrations/030_order_refunds.sql；adapters/order-refunds.ts；app/partial-refund-routes.ts
 */
import { withTransaction, type Db } from '../adapters/db.js';
import {
  listPartialRefunds,
  settlePartialRefund,
  sumPartialRefunds,
} from '../adapters/order-refunds.js';
import { restoreStockForOrder } from '../adapters/orders.js';
import { isOutOfStockRefundReason } from '@waselect/shared';
import { markRefunded, markRefunding } from '../adapters/orders-admin.js';
import type { EventBus } from '../ports/events.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { CircuitOpenError } from '../ports/circuit-breaker.js';
import type { PaymentProvider, RefundResult } from '../ports/payment.js';

export interface PartialRefundDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  /** 买家通知（第三轮缺口 P2-12）：成功一笔发 `order.partially_refunded`，退满发 `order.refunded`。 */
  events: EventBus;
}

export interface PartialRefundPlan {
  refundId: string;
  orderId: string;
  /** 通道名（只进日志）。 */
  channel: string;
  /** 支付行的机构单号（Stripe 会话号，适配器自己换成 payment_intent）。 */
  providerRef: string;
  currency: string;
  amountMinor: number;
  reason: string;
  actor: string;
}

type Outcome = RefundResult['outcome'];

export async function executePartialRefund(
  deps: PartialRefundDeps,
  provider: PaymentProvider,
  plan: PartialRefundPlan,
): Promise<Outcome> {
  if (provider.refund === undefined) {
    throw new AppError(50000, { order_id: plan.orderId, reason: 'refund_not_supported' });
  }
  let out: RefundResult;
  try {
    out = await provider.refund({
      orderId: plan.orderId,
      providerRef: plan.providerRef,
      // 只为满足端口形状：退款按原币最小单位执行，JPY 锚在部分退款里不参与任何计算
      amountJpy: 0,
      currency: plan.currency,
      amountMinor: plan.amountMinor,
      reason: plan.reason,
      partialRefundId: plan.refundId,
    });
  } catch (e) {
    const at = deps.clock.now();
    if (e instanceof CircuitOpenError) {
      // 🔴 AJ-414：熔断拒绝分两种——`attempted=false` 是"一次都没发出去"（可当失败、释放额度）；
      //    `attempted=true` 是"第 1 次已发出且结果未知、重试前才被拒"：机构可能已经退了这笔钱，
      //    此时必须按 unknown 处理（占住额度、下次 sync 同键重放），否则管理员重试会建新行新键 → 双退。
      const status = e.attempted ? 'unknown' : 'failed';
      await settlePartialRefund(deps.db, plan.refundId, status, null, at);
      deps.logger.warn('admin_partial_refund_circuit_open', {
        result: e.attempted ? 'unknown' : 'deferred',
        order_id: plan.orderId,
        ctx: {
          provider: plan.channel,
          refund_id: plan.refundId,
          retry_after_ms: e.retryAfterMs,
          attempted: e.attempted,
        },
      });
      throw e;
    }
    await settlePartialRefund(deps.db, plan.refundId, 'unknown', null, at);
    deps.logger.error('admin_partial_refund_unknown', {
      result: 'unknown',
      order_id: plan.orderId,
      ctx: { provider: plan.channel, refund_id: plan.refundId },
      err: e,
    });
    throw new AppError(50000, { order_id: plan.orderId, reason: 'partial_refund_unknown' });
  }
  return applyOutcome(deps, plan, out.outcome, out.refundRef);
}

/**
 * 同步一笔：pending → 按单号查；initiated / unknown → **同键重放**；已落定 → 原样返回。
 * @why initiated 也走重放：它只出现在"插入之后、拿到答复之前进程挂了"，与 unknown 是同一种不确定。
 */
export async function syncPartialRefund(
  deps: PartialRefundDeps,
  provider: PaymentProvider,
  plan: PartialRefundPlan,
): Promise<Outcome> {
  const current = (await listPartialRefunds(deps.db, plan.orderId)).find(
    (r) => r.id === plan.refundId,
  );
  if (current === undefined) {
    throw new AppError(40400, { order_id: plan.orderId, refund_id: plan.refundId });
  }
  if (current.status === 'succeeded' || current.status === 'failed') return current.status;
  if (current.status === 'pending' && current.provider_ref !== null) {
    if (provider.refundStatus === undefined) {
      throw new AppError(50000, { order_id: plan.orderId, reason: 'refund_not_supported' });
    }
    const status = await provider.refundStatus(current.provider_ref);
    return applyOutcome(deps, plan, status, current.provider_ref);
  }
  return executePartialRefund(deps, provider, plan);
}

async function applyOutcome(
  deps: PartialRefundDeps,
  plan: PartialRefundPlan,
  outcome: Outcome,
  refundRef: string,
): Promise<Outcome> {
  const at = deps.clock.now();
  const changed = await settlePartialRefund(deps.db, plan.refundId, outcome, refundRef, at);
  // 事件只在"这一次"落定时写（changed）：重放 / 并发同步不重复留痕
  if (changed && outcome === 'succeeded') {
    await event(
      deps.db,
      plan,
      'partial_refunded',
      `${plan.refundId}:${plan.currency}:${String(plan.amountMinor)}`,
      at,
    );
    deps.logger.info('admin_partial_refund_succeeded', {
      result: 'ok',
      order_id: plan.orderId,
      ctx: {
        provider: plan.channel,
        refund_id: plan.refundId,
        currency: plan.currency,
        amount_minor: plan.amountMinor,
      },
    });
    const fullyRefunded = await closeOutIfFullyRefunded(deps, plan, at);
    // 提交之后才发（本函数里每条写都已各自提交）；退满时只发整单退款那封，不再多发一封"部分退款"
    deps.events.publish(
      fullyRefunded
        ? { name: 'order.refunded', at: at.toISOString(), orderId: plan.orderId }
        : {
            name: 'order.partially_refunded',
            at: at.toISOString(),
            orderId: plan.orderId,
            payload: { refund_id: plan.refundId },
          },
    );
  }
  if (outcome === 'failed') {
    if (changed)
      await event(deps.db, plan, 'partial_failed', `${plan.refundId}:provider_failed`, at);
    deps.logger.error('admin_partial_refund_failed', {
      result: 'failed',
      order_id: plan.orderId,
      ctx: { provider: plan.channel, refund_id: plan.refundId },
    });
    throw new AppError(50000, { order_id: plan.orderId, reason: 'partial_failed' });
  }
  return outcome;
}

/**
 * 部分退款累计**退满实收**时的收尾（第三轮缺口 P2-1，AJ-385）：记 `refunded_by_parts` 事件；
 * 未发货（`shipped_at is null` 且 `paid_at` 非空）的单回补库存——与整单退款 `settle` 同一口径；
 * 已成功的几笔里有一笔理由是「缺货」预设则不回补（AJ-427：回补是整单的，没法只还有货的那几件；少记比多记安全）；
 * 并把订单**沿状态机**迁到 refunded（AJ-414：`paid | shipped | delivered → refunding → refunded`，同一事务）。
 * @why 要迁状态：此前只记事件不改状态，"钱已全退"的单仍是 paid——发货闸门放行、待采购 / 报关清单照出、
 *      列表「待发货」照列，而库存又已回补 ⇒ 运营会把一张全退的单采购发出，钱货两空、库存多卖一件。
 *      发货 / 导出 / 列表 / 工作台全都认 `orders.status`，改状态是唯一不漏消费方的修法。
 * @why 走 `markRefunding` + `markRefunded` 而不是直接 UPDATE 成 refunded：状态机没有 `paid → refunded` 的边，
 *      两步走让 `order_events` 留下与整单退款一致的轨迹，`payments.status` 也同步成 refunded
 *      （工作台"已退"口径 ①：全额那笔 = charge − 已成功部分退款 = 0，部分退款行各自按落定时刻计——合计不重不漏）。
 * @limitation completed 的单没有退款边（completed: []）：只记事件 + 日志，状态不变——它已不会再被发货，
 *             但仍会出现在"已完成"里；真要改口径需要先给状态机加边（技术文档 §1）。
 * @why 订单行锁 + "事件已存在就跳过"：两笔并发同步不可能都走到这里（一次只允许一笔在途），锁只是兜底，
 *      但回补不幂等，必须只做一次。
 * @returns 是否本次完成了收尾（调用方据此决定发哪个事件）。
 */
async function closeOutIfFullyRefunded(
  deps: PartialRefundDeps,
  plan: PartialRefundPlan,
  at: Date,
): Promise<boolean> {
  return withTransaction(deps.db, async (tx) => {
    const [o] = await tx`
      select o.shipped_at, o.paid_at, p.id as payment_id, p.charge_amount, p.charge_currency
        from orders o
        join order_refunds r on r.order_id = o.id and r.id = ${plan.refundId}
        join payments p on p.id = r.payment_id
       where o.id = ${plan.orderId}
       for update of o
    `;
    if (o === undefined) return false;
    const sums = await sumPartialRefunds(tx, plan.orderId);
    if (sums.succeededMinor < Number(o['charge_amount'])) return false;
    const done = await tx`
      select 1 from order_events where order_id = ${plan.orderId} and status = 'refunded_by_parts'
    `;
    if (done.length > 0) return false;
    await event(
      tx,
      plan,
      'refunded_by_parts',
      `${String(o['charge_currency'])}:${String(sums.succeededMinor)}`,
      at,
    );
    // AJ-427：退满的几笔里只要有一笔是「缺货」就不回补（回补是整单的，没法只还"有货"的那几件）
    const reasons = await tx<{ reason: string }[]>`
      select reason from order_refunds where order_id = ${plan.orderId} and status = 'succeeded'
    `;
    const outOfStock = reasons.some((r) => isOutOfStockRefundReason(r.reason));
    const restock = o['shipped_at'] === null && o['paid_at'] !== null && !outOfStock;
    if (restock) await restoreStockForOrder(tx, plan.orderId);
    // AJ-414：沿状态机迁到 refunded；completed 没有边 → markRefunding 返回 false，状态保持（@limitation）
    const moved =
      (await markRefunding(tx, plan.orderId, 'refunded_by_parts', at, plan.actor)) &&
      (await markRefunded(
        tx,
        plan.orderId,
        String(o['payment_id']),
        'refunded_by_parts',
        at,
        plan.actor,
      ));
    deps.logger.info('admin_partial_refund_fully_refunded', {
      result: 'ok',
      order_id: plan.orderId,
      ctx: {
        restocked: restock,
        out_of_stock: outOfStock,
        status_moved: moved,
      },
    });
    return true;
  });
}

async function event(
  db: Db,
  plan: PartialRefundPlan,
  status: string,
  note: string,
  at: Date,
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    values (${plan.orderId}, ${status}, ${note}, ${plan.actor}, ${at})
  `;
}
