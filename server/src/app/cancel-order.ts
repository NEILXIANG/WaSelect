/**
 * 职责：**取消订单核心**（I1-U5c）——在给定事务里完成一次用户取消：
 *      锁单 → 迁移合法性 → 迁移 + 作废旧支付行 + 释放库存。
 *
 * @why 从路由薄壳里抽出来（与 createOrder 同构）：取消的每一步都要在**同一个事务**里，
 *      且"锁单"必须在事务内（FOR UPDATE 的锁随事务结束释放）——
 *      路由只认 HTTP，把事务边界与步骤编排放在这里，测试才能用真事务直接调。
 *
 * @why 释放库存跟在迁移守卫之后（而不是触发器 / 定时补偿）：
 *      `restoreStockForOrder` **不幂等**（调一次加一次），`markOrderCancelled` 返回 true
 *      的那一刻就是"本次迁移是我干的"的排他凭证——释放跟在它后面同事务执行，
 *      要么一起落要么一起滚，不存在"单取消了库存没还"或"还了两次"的中间态。
 *
 * @limitation 一：只作废 **initiated** 支付行；succeeded 的钱走退款链路（I2 管理端），
 *              取消已支付订单在迁移表层面就不可达（paid → cancelled 不在表里 → 40902）。
 * @limitation 二：持锁下 `markOrderCancelled` 的 false 理论上不可达（锁已经把窗口焊死），
 *              但守卫条件仍写进 SQL——本函数也对"忘了先锁"的调用方保持安全（纵深）。
 *
 * @see domain/order.ts（迁移表）；adapters/orders.ts（SQL）；app/order-routes.ts（路由薄壳）；
 *      docs/I1阶段开发实施方案.md §3.5
 */
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import {
  findInitiatedPayment,
  findOwnedOrder,
  lockOwnedOrderForCancel,
  markOrderCancelled,
  restoreStockForOrder,
  voidInitiatedPayment,
} from '../adapters/orders.js';
import { asOrderStatus, assertTransition } from '../domain/order.js';
import type { PaymentRegistry } from '../ports/payment.js';

/**
 * 取消前的"**问机构一句**"（第三轮审查 MP3-04，P1）。
 *
 * 场景：买家在 Stripe 托管页付完款，切回微信只要几秒，而 `checkout.session.completed`
 * 常常还没到。此刻我方库里订单是 `pending_payment`、支付行是 `initiated`——
 * 按本地状态**完全合法**的取消会关单 + 回补库存；几秒后通知到达 → 变成
 * "钱收了、单关了"的迟到付款，只能人工退款，且货可能已经被别人买走。
 * 这一句问的是"这个会话付了没有"，本地数据答不出来。
 *
 * @why **在事务外**查（不在 `cancelOrder` 里）：机构调用不能进事务
 *      ——持锁等一个最长几秒的外部 HTTP，会把订单锁的持有时间从毫秒拉到秒级
 *      （ORD3-02 的同型缺陷：那时在点取消的人会拿到 50000）。
 * @why 只有 `pending_payment` 才问：`created` 还没有支付行；`expired` 本来就不可取消。
 * @throws {AppError} 40902 机构说已付 / 不确定（reason `payment_already_paid` / `payment_in_flight`）
 *                    | 50300 问不到（机构不可用）——**fail-closed**：查不到不敢取消
 *
 * @limitation 一：**残余窗口**。查询与取消事务之间仍有毫秒级缝隙：查完"未付"，
 *              紧接着买家在另一个标签页完成了支付 → 取消仍然会赢。
 *              完全堵死需要"取消时把支付行推进到 closing 并由回调裁决"的两阶段协议，
 *              那是 I2 的改造；这里把窗口从"秒级常态"压到"毫秒级残余"。
 * @limitation 二：查不到会话状态时**拒绝取消**（fail-closed）。代价是机构故障期间
 *              用户点不动取消（订单 30 分钟后自动关单，不会永久卡住）；
 *              收益是不会在机构不可用时关掉一张可能已付款的单。
 * @limitation 三：只查**在途**支付行（至多一条，`uq_payments_one_initiated`）。
 *              已 succeeded 的行走退款链路，取消在迁移表层面就不可达。
 *
 * @see ports/payment.ts（sessionStatus / supportsSessionQuery）；
 *      adapters/payment/stripe-checkout.ts（唯一实现者）
 */
export async function assertNoPaidSession(
  deps: { db: Db; logger: Logger; registry: PaymentRegistry },
  input: { orderId: string; userId: string },
): Promise<void> {
  const { db, logger, registry } = deps;
  const order = await findOwnedOrder(db, input.orderId, input.userId);
  if (order === null) throw new AppError(40400, { order_id: input.orderId });
  // 只问在途的那一支：created 没支付行、expired 不在可取消集合里
  if (asOrderStatus(order.status) !== 'pending_payment') return;

  const pay = await findInitiatedPayment(db, input.orderId);
  if (pay === null || pay.provider_ref === null) return;

  // getForCallback：已下线的通道也要能查（还有钱在路上时才需要这条防线）
  let provider;
  try {
    provider = registry.getForCallback(pay.provider);
  } catch {
    // 通道查不到 = 无法确认，按 fail-closed 拒绝
    throw new AppError(50300, { order_id: input.orderId, reason: 'session_query_unavailable' });
  }
  if (provider.capabilities.supportsSessionQuery !== true || provider.sessionStatus === undefined) {
    return; // in_app 类通道：机构侧没有可查对象，本地状态即全部事实
  }

  let status;
  try {
    status = await provider.sessionStatus(pay.provider_ref);
  } catch (e) {
    logger.error('cancel_session_query_failed', {
      order_id: input.orderId,
      result: 'failed',
      ctx: { provider: pay.provider },
      err: e,
    });
    throw new AppError(50300, { order_id: input.orderId, reason: 'session_query_failed' });
  }

  if (status === 'paid') {
    logger.warn('cancel_blocked_paid_session', {
      order_id: input.orderId,
      result: 'blocked',
      ctx: { provider: pay.provider, provider_ref: pay.provider_ref },
    });
    throw new AppError(40902, {
      order_id: input.orderId,
      reason: 'payment_already_paid',
    });
  }
  if (status === 'processing') {
    // 机构没说没付、也说不准付了：宁可让人等自动过期，也不关掉一张可能已付款的单
    logger.warn('cancel_blocked_session_in_flight', {
      order_id: input.orderId,
      result: 'blocked',
      ctx: { provider: pay.provider, provider_ref: pay.provider_ref },
    });
    throw new AppError(40902, { order_id: input.orderId, reason: 'payment_in_flight' });
  }
}

/**
 * 取消一张本人订单（**必须在调用方的事务里调用**，锁随事务存活）。
 *
 * ⚠️ 调用方必须先过 `assertNoPaidSession()`（MP3-04）：本函数只看本地状态，
 *    拦不住"买家已付款、通知未达"那一支。
 *
 * @throws {AppError} 40400 订单不存在或非本人 | 40902 当前状态不可取消
 */
export async function cancelOrder(
  tx: Db,
  deps: { clock: Clock; logger: Logger },
  input: {
    orderId: string;
    userId: string;
    /** 默认 `user:<userId>`；管理端代为取消时传 `admin:<sub>`（AJ-386）。 */
    actor?: string;
    /** 管理端取消的原因，进 order_events.note。 */
    note?: string;
  },
): Promise<void> {
  const { clock, logger } = deps;

  // ── 1. 持锁读单（归属判定：非本人与不存在同 40400，防存在性探测）────────────
  const order = await lockOwnedOrderForCancel(tx, input.orderId, input.userId);
  if (order === null) throw new AppError(40400, { order_id: input.orderId });

  // ── 2. 迁移合法性（唯一迁移表；仅 created / pending_payment → cancelled）─────
  assertTransition(asOrderStatus(order.status), 'cancelled', 'orders.cancel');

  // ── 3. 迁移（守卫 = 后续副作用的排他凭证；@limitation 二）────────────────────
  // actor 显式给"用户本人"：B28 起 markOrderCancelled 不再替调用方猜是谁
  // （风控拉黑连带取消必须显示成 admin 动作，不能显示成用户自己取消的）
  const transitioned = await markOrderCancelled(
    tx,
    input.orderId,
    input.userId,
    clock.now(),
    input.actor ?? `user:${input.userId}`,
    input.note ?? null,
  );
  if (!transitioned) {
    throw new AppError(40902, { from: order.status, to: 'cancelled', where: 'orders.cancel' });
  }

  // ── 4. 作废旧支付行 + 释放库存（跟在守卫之后，同事务）────────────────────────
  const voided = await voidInitiatedPayment(tx, input.orderId);
  const restored = await restoreStockForOrder(tx, input.orderId);

  logger.info('order_cancelled', {
    order_id: input.orderId,
    result: 'ok',
    ctx: { payment_voided: voided, stock_rows_restored: restored },
  });
}
