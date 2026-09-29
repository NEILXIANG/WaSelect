/**
 * 职责：管理端退款的**第二段**——事务外调机构、按机构结果落账（F-03，AJ-178，从 admin-order-routes 拆出）。
 *
 * 一次"点退款"按落库的退款进度（`findRefundProgress`）走三条路之一：
 *   ① 上一笔**在途**（最新事件是 refund_pending）→ 按单号**查询**，不再 POST：
 *      成功 → refunded；仍在途 → 原样返回 pending；机构确认失败 → 记确认失败，落到 ②；
 *   ② 发起退款：attempt = 已确认失败次数（换新幂等键）；
 *   ③ 发起的结果：成功 → refunded；在途 → 记 refund_pending（单号落库）；
 *      确认失败 → 记 `provider_failed:<单号>` 抛 50000；结果未知（抛错）→ 记 `provider_error` 抛 50000。
 *
 * @why 原先 pending 只打一条 info 日志：单号没落库，重试沿用同一幂等键，机构回放的是**首次响应快照**
 *      （仍是 pending）——订单永远停在 refunding、没有告警（独立审查辨析 §3.1）。
 *      出口有两个：这里的"再点即查询"，以及每日对账的 stuck_refunds（超过 24h 报出）。
 * @why "结果未知"与"确认失败"必须分开：前者换键可能退两次（机构已执行、我们没收到答复，KD-4），
 *      后者不换键永远拿回缓存的失败（机构对同键缓存执行结果 24h）。
 * @tradeoff 不接机构的退款回调（`charge.refunded` / `refund.updated`）自动落账：
 *      `charge.refunded` 在退款**创建**时还是**落定**时触发、部分退款时携带什么，未实测；
 *      按它迁 refunded 可能把在途甚至后来失败的退款记成已退。查询回的是退款对象本身的状态，语义确定。
 *      代价：pending 的单要靠人再点一次（或看到对账告警）才落定——MVP 退款量小，可接受。
 * @limitation 一：机构侧"已被别处退掉"（如在 Stripe 后台手工退款）→ 我方 POST 被拒、记 provider_error，
 *              同键重试拿回同一个拒绝——走不出 refunding。由 stuck_refunds 报出后人工处理（改库需留痕）。
 * @limitation 二：Stripe 文档注明退款在 succeeded 之后仍可能转为 failed（极少见）；本模块只在
 *              refunding 期间查询，refunded 之后的反转不在覆盖内（需要 refund.updated 回调，见 @tradeoff）。
 * @see docs/独立审查报告辨析与处置建议-2026-09-28.md §3.1（F-03）；docs/自主决策记录.md AJ-178 / AJ-175（KD-4）；
 *      app/daily-reconciliation.ts（stuck_refunds）；技术文档 v0.5 refunding 行（D-38 ⑧）
 */
import { withTransaction, type Db } from '../adapters/db.js';
import {
  markRefunded,
  recordRefundFailed,
  recordRefundPending,
  type RefundProgress,
} from '../adapters/orders-admin.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { PaymentProvider, RefundRequest, RefundResult } from '../ports/payment.js';

export interface RefundExecDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
}

/** 第一段（事务内）判定完、交给第二段的全部输入。 */
export interface RefundPlan {
  orderId: string;
  paymentId: string;
  /** 通道名（只进日志）。 */
  channel: string;
  /** 不含 attempt：第几把键由本模块按 `progress` 决定，调用方不该自己算。 */
  request: Omit<RefundRequest, 'attempt'>;
  progress: RefundProgress;
  /** `admin:<sub>`（order_events.actor 口径）。 */
  actor: string;
}

export async function executeRefund(
  deps: RefundExecDeps,
  provider: PaymentProvider,
  plan: RefundPlan,
): Promise<RefundResult['outcome']> {
  const { refund, refundStatus } = provider;
  if (refund === undefined || refundStatus === undefined) {
    throw new AppError(50000, { order_id: plan.orderId, reason: 'refund_not_supported' });
  }
  let attempt = plan.progress.confirmedFailures;
  const pendingRef = plan.progress.pendingRef;
  if (pendingRef !== null) {
    const status = await queryStatus(deps, plan, () => refundStatus.call(provider, pendingRef));
    if (status === 'succeeded') {
      await settle(deps, plan, pendingRef);
      return 'succeeded';
    }
    if (status === 'pending') {
      deps.logger.info('admin_order_refund_still_pending', {
        result: 'pending',
        order_id: plan.orderId,
        ctx: { provider: plan.channel },
      });
      return 'pending';
    }
    // 机构确认在途那笔失败：先留痕（下一把键由它计数），再在同一次点击里重新发起
    await recordRefundFailed(
      deps.db,
      plan.orderId,
      `provider_failed:${pendingRef}`,
      plan.actor,
      deps.clock.now(),
    );
    deps.logger.warn('admin_order_refund_confirmed_failed', {
      result: 'failed',
      order_id: plan.orderId,
      ctx: { provider: plan.channel, attempt: attempt + 1 },
    });
    attempt += 1;
  }

  let out: RefundResult;
  try {
    out = await refund.call(provider, { ...plan.request, attempt });
  } catch (e) {
    throw await fail(deps, plan, 'provider_error', e);
  }
  if (out.outcome === 'failed') throw await fail(deps, plan, `provider_failed:${out.refundRef}`);
  if (out.outcome === 'pending') {
    // 不 best-effort：单号写不进去就让这次请求失败——重试同键会拿回同一个单号，再写一次
    await recordRefundPending(deps.db, plan.orderId, out.refundRef, plan.actor, deps.clock.now());
    return 'pending';
  }
  await settle(deps, plan, out.refundRef);
  return 'succeeded';
}

async function settle(deps: RefundExecDeps, plan: RefundPlan, refundRef: string): Promise<void> {
  await withTransaction(deps.db, async (tx) => {
    await markRefunded(tx, plan.orderId, plan.paymentId, refundRef, deps.clock.now(), plan.actor);
  });
}

/** 查询失败 ≠ 退款失败：只打 error 日志、抛 50000，**不**写 refund_failed（否则会被数成确认失败）。 */
async function queryStatus(
  deps: RefundExecDeps,
  plan: RefundPlan,
  q: () => Promise<RefundResult['outcome']>,
): Promise<RefundResult['outcome']> {
  try {
    return await q();
  } catch (e) {
    deps.logger.error('admin_order_refund_status_query_failed', {
      result: 'failed',
      order_id: plan.orderId,
      ctx: { provider: plan.channel },
      err: e,
    });
    throw new AppError(50000, { order_id: plan.orderId, reason: 'refund_status_query_failed' });
  }
}

/** 两种失败形态都记 refund_failed 事件 + error 日志，返回 50000（C13）。事件写入 best-effort。 */
async function fail(
  deps: RefundExecDeps,
  plan: RefundPlan,
  kind: 'provider_error' | `provider_failed:${string}`,
  err?: unknown,
): Promise<AppError> {
  deps.logger.error('admin_order_refund_failed', {
    result: 'failed',
    order_id: plan.orderId,
    ctx: { provider: plan.channel, kind: kind.split(':')[0] },
    ...(err !== undefined ? { err } : {}),
  });
  await recordRefundFailed(deps.db, plan.orderId, kind, plan.actor, deps.clock.now()).catch(
    (e: unknown) =>
      deps.logger.error('admin_order_refund_failed_event_not_written', {
        result: 'failed',
        order_id: plan.orderId,
        err: e,
      }),
  );
  return new AppError(50000, { order_id: plan.orderId, reason: 'refund_failed' });
}
