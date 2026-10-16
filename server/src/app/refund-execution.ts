/**
 * 职责：管理端退款的**第二段**——事务外调机构、按机构结果落账（F-03，AJ-178，从 admin-order-routes 拆出）。
 *
 * 一次"点退款"按落库的退款进度（`findRefundProgress`）走三条路之一：
 *   ① 上一笔**在途**（最新事件是 refund_pending）→ 按单号**查询**，不再 POST：
 *      成功 → refunded；仍在途 → 原样返回 pending；机构确认失败 → 记确认失败，落到 ②；
 *   ② 发起退款：attempt = 已确认失败次数（换新幂等键）；
 *   ③ 发起的结果：成功 → refunded；在途 → 记 refund_pending（单号落库）；
 *      确认失败 → 记 `provider_failed:<单号>` 抛 50000；结果未知（抛错）→ 记 `provider_error` 抛 50000。
 *   ⚠️ 另有**拒付在途**的一个前提（第三轮审查 OPS3-03）：`hasDispute` 时不发起**新键**（40907），
 *      ① 的查询与 `attempt = 0` 的同键重放照常——它们不动第二笔钱。详见 `executeRefund` 内的注释。
 *
 * @why 原先 pending 只打一条 info 日志：单号没落库，重试沿用同一幂等键，机构回放的是**首次响应快照**
 *      （仍是 pending）——订单永远停在 refunding、没有告警（独立审查辨析 §3.1）。
 *      出口有两个：这里的"再点即查询"，以及每日对账的 stuck_refunds（超过 24h 报出）。
 * @why "结果未知"与"确认失败"必须分开：前者换键可能退两次（机构已执行、我们没收到答复，KD-4），
 *      后者不换键永远拿回缓存的失败（机构对同键缓存执行结果 24h）。
 * @tradeoff 不接机构的退款回调（`charge.refunded` / `refund.updated`）自动落账：
 *      `charge.refunded` 在退款**创建**时还是**落定**时触发，未实测；
 *      按它迁 refunded 可能把在途甚至后来失败的退款记成已退。查询回的是退款对象本身的状态，语义确定。
 *      代价：pending 的单要靠人再点一次（或看到对账告警）才落定——MVP 退款量小，可接受。
 *      ⚠️ 复核 AJ-376（2026-10-06）订正：`charge.refunded` 的事件对象是**整张 Charge**，但 Stripe 自
 *        API 2022-11-15 起 Charge **不再自动展开 `refunds`**（本仓钉 2025-03-31.basil），webhook 载荷里
 *        大概率拿不到 `refunds.data[]`——AJ-376 引的样例是 2023-10-16 版本的第三方转载，不能套用。
 *        所以将来要接回调，应订阅 `refund.created` / `refund.updated`（对象就是 Refund，自带 status），
 *        而不是解析 charge.refunded。触发时机同样未实测。
 *        实测办法：`stripe listen --forward-to localhost:…/api/v1/pay/callback/stripe` 下发起一笔退款，
 *        看收到哪些事件、载荷里有什么（计入 B9 之后的 Stripe test mode 联调清单）。
 *        @see adapters/payment/stripe-checkout.ts 的 OUTCOME_BY_TYPE['charge.refunded']（三个金额字段的语义）
 * @limitation 一：机构侧"已被别处退掉"（如在 Stripe 后台手工退款）→ 我方 POST 被拒、记 provider_error，
 *              同键重试拿回同一个拒绝——走不出 refunding。由 stuck_refunds 报出后人工处理（改库需留痕）。
 * @limitation 二：Stripe 文档注明退款在 succeeded 之后仍可能转为 failed（极少见）；本模块只在
 *              refunding 期间查询，refunded 之后的反转不在覆盖内（需要 refund.updated 回调，见 @tradeoff）。
 * @see docs/独立审查报告辨析与处置建议-2026-09-28.md §3.1（F-03）；docs/自主决策记录.md AJ-178 / AJ-175（KD-4）；
 *      app/daily-reconciliation.ts（stuck_refunds）；技术文档 v0.5 refunding 行（D-38 ⑧）
 */
import { withTransaction, type Db } from '../adapters/db.js';
import {
  findLatePaidPayment,
  findRefundablePayment,
  findRefundingReason,
  findRefundProgress,
  hasLatePaid,
  markRefunded,
  recordRefundFailed,
  recordRefundPending,
  type RefundProgress,
} from '../adapters/orders-admin.js';
import { restoreStockForOrder } from '../adapters/orders.js';
import { isOutOfStockRefundReason } from '@waselect/shared';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
// 值导入（不是 type）：AJ-313 —— 熔断拒绝必须**按类型**分辨出来原样抛，
// 折叠成 50000 会把"约 N ms 后可重试"这条信息丢掉（errors.ts 对它映射 50300 + retry_after_ms）
import { CircuitOpenError } from '../ports/circuit-breaker.js';
import {
  ProviderRejectedError,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
} from '../ports/payment.js';

export interface RefundExecDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  /** 退款落定后发 `order.refunded`（剩余清单 2-1）。 */
  events: EventBus;
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
  /**
   * `orders.has_dispute`：拒付进行中（第三轮审查 OPS3-03）。
   * @why 它必须**传进来**而不是在闸门里一次判完：本模块才知道"这一把是不是新键"
   *      （`attempt = confirmedFailures`，见下），而"动第二笔钱"只发生在换键那一步。
   *      闸门（`refundGuard`）只看 `status × has_dispute`，把 refunding 一律放行，
   *      否则拒付在途时订单会永久卡在 refunding。
   */
  hasDispute: boolean;
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

  // ── 拒付在途时，只在这一步拦（OPS3-03）──────────────────────────────────────
  // `attempt > 0` = 这一把是**新键**（`refund:<orderId>:<attempt>`），即会向机构发起
  // 一笔**新的**退款；`attempt === 0` 是同键重放，机构回放首次结果，钱不会动第二次。
  // @why 拦在这里而不是把 refunding 一并挡在闸门里：挡闸门 = 连"查询在途那笔"都点不动
  //      ⇒ 退款 pending 期间落了拒付的单永远退不掉，也回不到 paid（stuck_refunds 天天报）。
  // @why 顺序在**记录确认失败之后**：上面 pending 查询拿到 failed 时已经写了
  //      `refund_failed` 事件，那笔失败是事实，不能因为拒付就当没发生（否则 attempt 不进位，
  //      下次点又会拿同一把键去撞那个已被确认失败的单号）。
  // @limitation 拒付 + 同键重放仍可能落定：买家既拿到退款又赢了拒付。这是刻意选的方向——
  //      另一个方向（一律挡）的后果是"订单永久卡死且无出口"，而这条路的钱只动一次、
  //      `has_dispute` 仍在、对账看得见。
  if (plan.hasDispute && attempt > 0) {
    deps.logger.warn('admin_order_refund_blocked_by_dispute', {
      result: 'blocked',
      order_id: plan.orderId,
      ctx: { provider: plan.channel, attempt },
    });
    throw new AppError(40907, { order_id: plan.orderId, reason: 'dispute_open' });
  }

  let out: RefundResult;
  try {
    out = await refund.call(provider, { ...plan.request, attempt });
  } catch (e) {
    // 🔴 **被熔断拒绝不是"机构失败"**（AJ-313）：这一次请求**一次都没有发出去**
    //    ——熔断在出发前就把它拒了。若按下面 `provider_error` 处理，会发生两件事：
    //    ① 记一条 `refund_failed` 事件，事件流于是写着"机构失败了"，而机构根本没被问过；
    //    ② 抛 `AppError(50000)`，把 `CircuitOpenError` 自带的"约 N ms 后重试"丢掉
    //       ——管理员看到"服务器内部错误"，真正该说的是"上游在恢复，稍后再试"。
    //    同一类错误在**发起支付**那边是原样抛的（pay-intent.ts：`createSessionOr50001`
    //    明令"熔断 CircuitOpenError 原样抛——翻成 50001 会丢掉重试时刻"），
    //    这里必须同口径：50300 + `retry_after_ms` 由 errors.ts 统一映射。
    // @why 不记事件：留痕由这条 warn 承担；写进 `order_events` 会污染"确认失败"的计数口径
    //      （`findRefundProgress` 只数 `provider_failed:*`，所以不会换键，但事件流会误导人）。
    if (e instanceof CircuitOpenError) {
      deps.logger.warn('admin_order_refund_circuit_open', {
        result: 'deferred',
        order_id: plan.orderId,
        ctx: { provider: plan.channel, retry_after_ms: e.retryAfterMs },
      });
      throw e;
    }
    // 独立排查 2026-10-14 C-2：机构**确定拒绝**（4xx，`ProviderRejectedError`）≠ 结果未知——这把键什么都没退出去，
    //   且同键重放只会拿回同一个 4xx。记成 `provider_failed:rejected:<status>:a<attempt>`，`findRefundProgress` 把它计入"确认失败"，
    //   下一次点击换新键重新发起（与机构答复 failed 同口径）；`provider_error` 仍只给超时 / 5xx / 网络错（KD-4：同键）。
    //   @limitation 换键后若拒绝原因没变（金额超出），还是会再拒一次——但每次都留下一条带状态码的事件，而不是无声地同键打转。
    //   @why note 带 `a<attempt>`（四天提交复查 2026-10-16）：`findRefundProgress` 按**不同 note** 去重计数（OPS3-06），
    //        原先 note 只有状态码，第二次同码拒绝与第一次同串 → 计数停在 1、之后永远重放第 1 把键。
    //        带上这把键的序号后，同一把键的并发重复事件仍去重，不同键的拒绝各算一次。
    if (e instanceof ProviderRejectedError) {
      throw await fail(
        deps,
        plan,
        `provider_failed:rejected:${String(e.status)}:a${String(attempt)}`,
        e,
      );
    }
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

/**
 * 退款落定：订单 → refunded、支付行 → refunded；**未发货的单同时回补库存**（剩余清单 1-1 / C32）。
 * @why 退完库存却停在扣减后的值，运营要记得手动改——
 *      技术文档 §2.3 本来就写"cancelled / expired / 退款时释放"，退款这一条此前没兑现。
 * @why 已发货（`shipped_at` 非空）不回补：货已经寄出，退款不代表货回来了；退货入库属人工流程。
 * @why 回补跟在 `markRefunded` 返回 true 之后、同一事务：true 是"这次落定是我做的"的排他凭证，
 *      回补不幂等，必须只做一次（与关单、取消同一口径）。锁序先 orders 后 products，与关单一致。
 * @why 迟到付款的单（`paid_at` 为空，剩余清单 1-5）不回补：关单那一刻库存已经还过一次，再还就是凭空多货。
 * @why 理由是「缺货」预设的不回补（AJ-427，统一结论 5.2）：货本来就没有，加回去等于重新开卖一件买不到的东西——
 *      少记库存运营可在商品管理里改回，多记的代价是下一位买家付了款再被退一次。
 *      判定用 `plan.request.reason`：路由在重试时已换成**首次**登记的理由（findRefundingReason），所以 pending 之后才落定也认得出。
 *      （本函数原注释以"缺货是最常见的退款原因"作为回补的理由，那一句的方向是反的，已改。）
 */
/**
 * 机构回调推进**整单退款**（审计 PAY-03，2026-10-14，AJ-530）：只认"订单在 refunding 且在途单号就是这笔"。
 * @why 原先在途（pending）的整单退款只能等管理员再点一次去查；机构侧失败也无人知道。
 * @why 对不上（订单不在退款中 / 单号不是在途那笔）一律 noop：回调可能晚于管理员手动同步到达，也可能是我们不认识的退款，
 *      不在这里猜。落定走与管理端同一个 `settle`（markRefunded 带状态条件，重复到达只落一次）。
 * @limitation 控制台手工退款没有我们的 metadata，适配器判为非本系统事件（unknown），不会走到这里。
 * @returns 'full' = 本次处理了；'noop' = 对不上或无需处理
 */
export async function settleFullRefundFromProvider(
  deps: RefundExecDeps,
  i: { orderId: string; refundRef: string; outcome: RefundResult['outcome']; actor: string },
): Promise<'full' | 'noop'> {
  if (i.outcome === 'pending') return 'noop';
  const [o] = await deps.db`select status from orders where id = ${i.orderId}`;
  if (o?.['status'] !== 'refunding') return 'noop';
  const progress = await findRefundProgress(deps.db, i.orderId);
  if (progress.pendingRef !== i.refundRef) return 'noop';
  if (i.outcome === 'failed') {
    await recordRefundFailed(
      deps.db,
      i.orderId,
      `provider_failed:${i.refundRef}`,
      i.actor,
      deps.clock.now(),
    );
    return 'full';
  }
  // 迟到付款的单（四天提交复查 2026-10-16）：支付行从来不是 succeeded（落账事务回滚），常规查不到——
  //   与管理端路由同一回退（admin-order-routes.ts：refunding 时找不到 succeeded 就按 late_paid 凭据找）
  const pay =
    (await findRefundablePayment(deps.db, i.orderId)) ??
    ((await hasLatePaid(deps.db, i.orderId))
      ? await findLatePaidPayment(deps.db, i.orderId)
      : null);
  const reason = await findRefundingReason(deps.db, i.orderId);
  if (pay === null || reason === null) return 'noop';
  // settle 只读 orderId / paymentId / request.reason / actor（@see settle）
  const plan = {
    orderId: i.orderId,
    paymentId: pay.id,
    request: { reason },
    actor: i.actor,
  } as unknown as RefundPlan;
  await settle(deps, plan, i.refundRef);
  return 'full';
}

async function settle(deps: RefundExecDeps, plan: RefundPlan, refundRef: string): Promise<void> {
  const at = deps.clock.now();
  const done = await withTransaction(deps.db, async (tx) => {
    const settled = await markRefunded(tx, plan.orderId, plan.paymentId, refundRef, at, plan.actor);
    if (!settled) return false;
    const unshipped = await tx`
      select 1 from orders
       where id = ${plan.orderId} and shipped_at is null and paid_at is not null
    `;
    if (unshipped.length > 0) {
      if (isOutOfStockRefundReason(plan.request.reason)) {
        deps.logger.info('order_restock_skipped', {
          result: 'skipped',
          order_id: plan.orderId,
          ctx: { reason: 'out_of_stock_refund' },
        });
      } else {
        await restoreStockForOrder(tx, plan.orderId);
      }
    }
    return true;
  });
  // 提交之后才发；第二次落定（done=false）不发，避免同一笔退款通知两次
  if (done) {
    deps.events.publish({ name: 'order.refunded', at: at.toISOString(), orderId: plan.orderId });
  }
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
    // 与上面同口径（AJ-313）：查询被熔断拦下 = "没问成"，不是"机构答复了"。
    // ⚠️ 这条尤其不能折成 50000：在途退款的唯一出口就是"再点一次即查询"
    //    （文件头 ①），把"稍后再试"说成"服务器内部错误"会让人怀疑退款已经坏了，
    //    进而去做手工改库这类更危险的事。
    if (e instanceof CircuitOpenError) {
      deps.logger.warn('admin_order_refund_status_circuit_open', {
        result: 'deferred',
        order_id: plan.orderId,
        ctx: { provider: plan.channel, retry_after_ms: e.retryAfterMs },
      });
      throw e;
    }
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
