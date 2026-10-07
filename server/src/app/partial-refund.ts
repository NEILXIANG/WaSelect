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
      await settlePartialRefund(deps.db, plan.refundId, 'failed', null, at);
      deps.logger.warn('admin_partial_refund_circuit_open', {
        result: 'deferred',
        order_id: plan.orderId,
        ctx: { provider: plan.channel, refund_id: plan.refundId, retry_after_ms: e.retryAfterMs },
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
 * 未发货（`shipped_at is null` 且 `paid_at` 非空）的单回补库存——与整单退款 `settle` 同一口径。
 * @why 订单状态**不改**：completed / shipped 的单走到 refunded 需要新的状态机边（技术文档 §1 未定义）；
 *      事件 + 库存是"账与货"层面的收尾，状态口径留给 F12 定。
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
      select o.shipped_at, o.paid_at, p.charge_amount, p.charge_currency
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
    if (o['shipped_at'] === null && o['paid_at'] !== null)
      await restoreStockForOrder(tx, plan.orderId);
    deps.logger.info('admin_partial_refund_fully_refunded', {
      result: 'ok',
      order_id: plan.orderId,
      ctx: { restocked: o['shipped_at'] === null && o['paid_at'] !== null },
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
