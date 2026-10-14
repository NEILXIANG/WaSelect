/**
 * 职责：管理端**部分退款**两条路由（AJ-383）——发起一笔、同步一笔。订单状态不动。
 *
 * - `POST /admin/orders/:id/partial-refunds`  `{ amount_minor, reason }` → 202 `{ refund }`
 *   第一段（事务、订单行锁内）：准入判定（domain/partial-refund.ts）+ 解析通道 + 登记一行 initiated；
 *   第二段（事务外）：调机构，按结果推进那一行（app/partial-refund.ts）。
 * - `POST /admin/orders/:id/partial-refunds/:refundId/sync` → 200 `{ refund }`
 *   pending 按单号查询；initiated / unknown 同键重放；已落定原样返回。
 *
 * @why 额度判定与登记在**同一事务、订单行锁内**：锁与整单退款是同一把（`lockAdminOrder`），
 *      两种退款互相看得见——不会出现"部分退款刚登记、整单退款按全额又退一遍"。
 * @why 通道在事务内解析（与整单退款 B8 同口径）：拿不到通道就整体回滚，不留一行永远在途的 initiated。
 * @why 第一段提交后立刻 `markAuditCommitted`：第二段失败回 5xx 时，"谁发起了这笔退款"仍要进审计（AJ-339）。
 * @limitation 金额单位是支付币种最小单位（迁移 030 @why）；管理端负责把"美元 10.00"换成 1000 再提交。
 *
 * @see domain/partial-refund.ts；app/partial-refund.ts；adapters/order-refunds.ts；契约 0.6.35
 */
import type { Express, Request } from 'express';
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { withTransaction, type Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import {
  insertPartialRefund,
  listPartialRefunds,
  sumPartialRefunds,
  type PartialRefundRow,
} from '../adapters/order-refunds.js';
import { findRefundablePayment, lockAdminOrder } from '../adapters/orders-admin.js';
import { refundReasonGuard } from '../domain/admin-order-actions.js';
import { asOrderStatus } from '../domain/order.js';
import { partialRefundGuard } from '../domain/partial-refund.js';
import { AppError } from '../errors.js';
import { gateError } from './admin-order-utils.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { PaymentRegistry } from '../ports/payment.js';
import type { EventBus } from '../ports/events.js';
import { markAuditCommitted } from './admin-audit.js';
import { requireRole, type AuthConfig } from './auth.js';
import {
  executePartialRefund,
  syncPartialRefund,
  type PartialRefundPlan,
} from './partial-refund.js';

export interface PartialRefundRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  idGen: IdGen;
  auth: AuthConfig;
  identity: IdentityCheck;
  registry: PaymentRegistry;
  /** 部分退款成功 / 退满后的买家通知（P2-12）。 */
  events: EventBus;
}

const actorOf = (req: Request): string => `admin:${req.auth?.sub ?? 'unknown'}`;

/** 行 → 契约 `PartialRefund`（管理端订单详情的 `partial_refunds` 也用它）。 */
export function partialRefundView(r: PartialRefundRow): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    currency: r.currency,
    amount_minor: r.amount_minor,
    reason: r.reason,
    actor: r.actor,
    created_at: r.created_at.toISOString(),
    ...(r.settled_at !== null ? { settled_at: r.settled_at.toISOString() } : {}),
  };
}

async function viewOf(db: Db, orderId: string, refundId: string): Promise<Record<string, unknown>> {
  const row = (await listPartialRefunds(db, orderId)).find((r) => r.id === refundId);
  if (row === undefined) throw new AppError(40400, { order_id: orderId, refund_id: refundId });
  return partialRefundView(row);
}

export function mountPartialRefundRoutes(app: Express, deps: PartialRefundRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.post('/api/v1/admin/orders/:id/partial-refunds', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const body = (req.body ?? {}) as { amount_minor?: unknown; reason?: unknown };
        const reasonCheck = refundReasonGuard(body.reason);
        if (!reasonCheck.ok) {
          throw new AppError(reasonCheck.code, {
            reason: reasonCheck.reason,
            ctx: { max: REFUND_REASON_MAX_LENGTH },
          });
        }
        const amountMinor = typeof body.amount_minor === 'number' ? body.amount_minor : Number.NaN;
        const plan = await withTransaction(
          deps.db,
          async (
            tx,
          ): Promise<
            PartialRefundPlan & { provider: ReturnType<PaymentRegistry['getForRefund']> }
          > => {
            const row = await lockAdminOrder(tx, id);
            if (row === null) throw new AppError(40400, { order_id: id });
            const status = asOrderStatus(row.status);
            const pay = await findRefundablePayment(tx, id);
            // 整单已退（支付行 refunded）/ 没收到钱：没有 succeeded 支付行。先按状态报（refunded → 40902 status_refunded）
            if (pay === null) {
              throw new AppError(40902, { order_id: id, reason: `no_succeeded_payment:${status}` });
            }
            // 通道先解析（B8 同口径：拿不到通道整体回滚），能力声明进准入判定（P2-4）
            const provider = deps.registry.getForRefund(pay.provider);
            const sums = await sumPartialRefunds(tx, id);
            const gate = partialRefundGuard({
              status,
              // 审计 PAY-07：限制被人工解除但拒付仍在进行中，同样拒（40907）
              hasDispute: row.has_dispute || pay.open_dispute,
              chargeAmountMinor: pay.charge_amount,
              reservedMinor: sums.reservedMinor,
              inFlight: sums.inFlight,
              amountMinor,
              channelSupportsPartial: provider.capabilities.supportsPartialRefund,
              lostDisputeMinor: pay.lost_dispute_minor,
            });
            if (!gate.ok) throw gateError(gate, { order_id: id });
            if (pay.provider_ref === null)
              throw new AppError(50000, { order_id: id, reason: 'provider_ref_missing' });
            const refundId = `rf-${deps.idGen.uuid()}`;
            await insertPartialRefund(tx, {
              id: refundId,
              orderId: id,
              paymentId: pay.id,
              currency: pay.charge_currency,
              amountMinor,
              reason: reasonCheck.reason,
              actor: actorOf(req),
            });
            return {
              provider,
              refundId,
              orderId: id,
              channel: pay.provider,
              providerRef: pay.provider_ref,
              currency: pay.charge_currency,
              amountMinor,
              reason: reasonCheck.reason,
              actor: actorOf(req),
            };
          },
        );
        markAuditCommitted(res);
        await executePartialRefund(deps, plan.provider, plan);
        res.status(202).json({ refund: await viewOf(deps.db, id, plan.refundId) });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/partial-refunds/:refundId/sync', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const refundId = String(req.params.refundId);
        const row = (await listPartialRefunds(deps.db, id)).find((r) => r.id === refundId);
        if (row === undefined) throw new AppError(40400, { order_id: id, refund_id: refundId });
        const [pay] =
          await deps.db`select provider, provider_ref from payments where id = ${row.payment_id}`;
        const channel = String(pay?.['provider'] ?? '');
        await syncPartialRefund(deps, deps.registry.getForRefund(channel), {
          refundId,
          orderId: id,
          channel,
          providerRef: String(pay?.['provider_ref'] ?? ''),
          currency: row.currency,
          amountMinor: row.amount_minor,
          reason: row.reason,
          actor: actorOf(req),
        });
        res.json({ refund: await viewOf(deps.db, id, refundId) });
      } catch (e) {
        next(e);
      }
    })();
  });
}
