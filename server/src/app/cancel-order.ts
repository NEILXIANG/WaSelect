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
  lockOwnedOrderForCancel,
  markOrderCancelled,
  restoreStockForOrder,
  voidInitiatedPayment,
} from '../adapters/orders.js';
import { asOrderStatus, assertTransition } from '../domain/order.js';

/**
 * 取消一张本人订单（**必须在调用方的事务里调用**，锁随事务存活）。
 *
 * @throws {AppError} 40400 订单不存在或非本人 | 40902 当前状态不可取消
 */
export async function cancelOrder(
  tx: Db,
  deps: { clock: Clock; logger: Logger },
  input: { orderId: string; userId: string },
): Promise<void> {
  const { clock, logger } = deps;

  // ── 1. 持锁读单（归属判定：非本人与不存在同 40400，防存在性探测）────────────
  const order = await lockOwnedOrderForCancel(tx, input.orderId, input.userId);
  if (order === null) throw new AppError(40400, { order_id: input.orderId });

  // ── 2. 迁移合法性（唯一迁移表；仅 created / pending_payment → cancelled）─────
  assertTransition(asOrderStatus(order.status), 'cancelled', 'orders.cancel');

  // ── 3. 迁移（守卫 = 后续副作用的排他凭证；@limitation 二）────────────────────
  const transitioned = await markOrderCancelled(tx, input.orderId, input.userId, clock.now());
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
