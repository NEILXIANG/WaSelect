/**
 * 职责：退款进展回调落账（审计 PAY-03，2026-10-14，AJ-530）——机构报"某笔退款成功 / 失败了"时，
 *      推进本系统对应的那一笔：部分退款按 `order_refunds.provider_ref` 匹配，整单退款按在途单号（refund_pending）匹配。
 *
 * @why 契约早已订阅 refund.updated / refund.failed，原先管线没有落账器（一律 ignored）：
 *      pending 的退款只能等管理员再点一次「同步 / 重新提交退款」才落定；机构侧失败无人知道，订单一直显示"退款中"。
 * @why 与管理端同步走**同一个落定函数**（partial-refund.ts applyOutcome / refund-execution.ts settle）：
 *      两条路径谁先到谁落定，另一条看到已落定就不再动（落定都带状态条件）。
 * @limitation 一：控制台手工退款没有我们的 metadata，适配器判为非本系统事件，不走这里（运维手册规定不在控制台退款）。
 * @limitation 二：结果未知（unknown / initiated）的部分退款行没有机构单号，匹配不上——仍靠管理端「同步」同键重放。
 * @see app/partial-refund.ts；app/refund-execution.ts settleFullRefundFromProvider；adapters/payment/stripe-checkout.ts
 */
import type { Db } from '../adapters/db.js';
import { listPartialRefunds } from '../adapters/order-refunds.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import type { RefundResult } from '../ports/payment.js';
import { applyOutcome } from './partial-refund.js';
import { settleFullRefundFromProvider } from './refund-execution.js';

export interface RefundProgressDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  events: EventBus;
}

/**
 * @returns 'partial' / 'full' = 本次推进了哪一种；'noop' = 对不上或无需处理（pending、已落定）
 */
export async function applyProviderRefundProgress(
  deps: RefundProgressDeps,
  i: { orderId: string; channel: string; refundRef: string; outcome: RefundResult['outcome'] },
): Promise<'partial' | 'full' | 'noop'> {
  if (i.outcome === 'pending') return 'noop';
  const row = (await listPartialRefunds(deps.db, i.orderId)).find(
    (r) => r.provider_ref === i.refundRef,
  );
  if (row !== undefined) {
    if (row.status === 'succeeded' || row.status === 'failed') return 'noop';
    const [p] = await deps.db`select provider_ref from payments where id = ${row.payment_id}`;
    const plan = {
      refundId: row.id,
      orderId: i.orderId,
      channel: i.channel,
      providerRef: String(p?.['provider_ref'] ?? ''),
      currency: row.currency,
      amountMinor: row.amount_minor,
      reason: row.reason,
      actor: row.actor,
    };
    try {
      await applyOutcome(deps, plan, i.outcome, i.refundRef);
    } catch (e) {
      // 管理端路径把"机构确认失败"抛成 50000 给运营看；回调这里已经落定为 failed，不需要再抛（抛了机构会一直重发）
      if (!(e instanceof AppError && e.code === 50000)) throw e;
    }
    return 'partial';
  }
  const full = await settleFullRefundFromProvider(deps, {
    orderId: i.orderId,
    refundRef: i.refundRef,
    outcome: i.outcome,
    actor: `provider:${i.channel}`,
  });
  deps.logger.info('provider_refund_progress', {
    order_id: i.orderId,
    result: full === 'full' ? 'ok' : 'skipped',
    ctx: { channel: i.channel, kind: full, outcome: i.outcome },
  });
  return full;
}
