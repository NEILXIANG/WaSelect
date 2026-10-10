/**
 * 职责：**一单**发货的完整执行（入参校验 → 事务内持锁判定 + 迁移 → 提交后日志与 `order.shipped` 事件）。
 *      单单发货（`POST /admin/orders/{id}/ship`）与批量发货（`POST /admin/orders/ship-batch`，AJ-401）
 *      都只调这一个函数。
 *
 * @why 从 admin-order-routes.ts 原样搬出来（AJ-401），而不是让批量路由"照着写一份"：
 *      发货的闸门有四道（测试单 / 拒付 40909 / 状态机 / 列宽），外加"事务提交后才发事件"这条顺序。
 *      两份实现迟早漂移——哪天单单那边加了一道闸门、批量没加，批量就成了绕过闸门的后门，
 *      而这种漂移不会让任何既有用例变红。
 * @why 失败一律**抛 AppError**（与搬家前同形）：单单路由交给全局错误中间件，批量路由逐单 catch。
 *      `details.reason` 统一带上（含 40400 的 `not_found`），批量要把它按行回给前端。
 *
 * @limitation 一：事件只在**事务提交之后**发（回滚了就不该有人收到"已发货"邮件）；
 *              代价是"已提交、发事件之前进程崩溃"会少一封邮件——与搬家前一致，订单状态仍正确。
 * @limitation 二：没有幂等键：同一单再发一次是 40902（`status_shipped`），不是"幂等成功"。
 *              批量重提（网络断开后再点一次）时，上一次已成功的行会显示 40902，前端按 reason 转述为"已发货"。
 * @limitation 三：撤销发货（AJ-440）之后再发货，发货邮件的幂等键带 `reship-<n>`（n = 本单撤销次数）——
 *              否则服务商按首封的 `order.shipped:<订单>` 去重，带新运单号的那封发不出去。
 * @see domain/admin-order-actions.ts（shipGuard / shipInfoGuard）；adapters/orders-admin.ts（lockAdminOrder / markShipped）
 */
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import { withTransaction } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import { asOrderStatus } from '../domain/order.js';
import { shipGuard, shipInfoGuard } from '../domain/admin-order-actions.js';
import { trackingNoRecognized } from '../domain/tracking.js';
import { countShipmentReverts, lockAdminOrder, markShipped } from '../adapters/orders-admin.js';

export interface ShipOrderDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  events: EventBus;
}

/** 发货成功的响应体（契约 `POST /admin/orders/{id}/ship` 200）。 */
export interface ShippedView {
  order_id: string;
  status: 'shipped';
  carrier: string;
  tracking_no: string;
  tracking_recognized: boolean;
}

/**
 * @param raw 请求体（`{carrier, tracking_no}`；批量时是数组里的那一项）
 * @param actor `admin:<sub>`（进 order_events.actor）
 * @param logCtx 附加进成功日志的 ctx（批量传 `{batch: true}`，便于区分来源）
 * @throws {AppError} 40001（列宽 / 必填）、40400、40902、40909；DB 异常原样抛出
 */
export async function shipOrder(
  deps: ShipOrderDeps,
  id: string,
  raw: unknown,
  actor: string,
  logCtx?: Record<string, unknown>,
): Promise<ShippedView> {
  // ⚠️ 必填 + **列宽**都在入口判（AJ-315 / 第二轮审查 B24）：此前只判非空，
  //    超长会撞 PG 的 22001 → 兜底层折成泛化的 40001，运营看到的不是"运单号太长"。
  const ship = shipInfoGuard(raw);
  if (!ship.ok) throw new AppError(ship.code, { reason: ship.reason, order_id: id });
  const reverts = await withTransaction(deps.db, async (tx) => {
    const row = await lockAdminOrder(tx, id);
    if (row === null) throw new AppError(40400, { order_id: id, reason: 'not_found' });
    const gate = shipGuard(asOrderStatus(row.status), row.has_dispute, row.is_test);
    if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
    if (!(await markShipped(tx, id, ship.carrier, ship.trackingNo, deps.clock.now(), actor))) {
      throw new AppError(40902, { order_id: id, reason: 'status_raced' });
    }
    return countShipmentReverts(tx, id);
  });
  deps.logger.info('admin_order_shipped', {
    result: 'ok',
    order_id: id,
    ...(logCtx !== undefined ? { ctx: logCtx } : {}),
  });
  // 事务已提交才发（与 unit-of-work 同口径：回滚了就不该有人收到"已发货"）
  deps.events.publish({
    name: 'order.shipped',
    at: deps.clock.now().toISOString(),
    orderId: id,
    payload: {
      carrier: ship.carrier,
      ...(reverts > 0 ? { mail_key: `reship-${String(reverts)}` } : {}),
    },
  });
  return {
    order_id: id,
    status: 'shipped',
    carrier: ship.carrier,
    tracking_no: ship.trackingNo,
    // 形状认得出（能生成官方查件链接）才是 true；false 只提示运营核对，不拦（P1-10，AJ-386）
    tracking_recognized: trackingNoRecognized(ship.carrier, ship.trackingNo),
  };
}
