/**
 * 职责：`POST /api/v1/orders/:id/confirm-receipt`——买家确认收货（第三轮缺口 P2-13，AJ-387）。
 *       shipped → delivered，写 delivered_at 与事件（actor = `user:<sub>`），提交后发 `order.delivered`。
 *
 * @why 原先签收只有"发货满 AUTO_DELIVER_DAYS（30）天自动签收"一条路：EMS 到美 7–14 天，
 *      货早到了，"已发货"里却混着大量其实已签收的单，完成（售后窗口关闭）也被推迟到 37 天后。
 *      目标用户熟悉"确认收货"（国内电商习惯），给出口比让系统猜更准；自动签收仍是兜底。
 * @why 已签收 / 已完成 → 200 原样（幂等）：买家连点、或自动签收刚好先一步，都不该看到报错。
 * @why 有拒付限制（has_dispute）→ 40902：与自动签收同口径（拒付中的单不推进状态，D-50）。
 * @why 别人的单与不存在同为 40400：与订单详情同口径，不泄露"这单存在但是别人的"。
 * @limitation 不发邮件：签收是买家自己做的动作，不需要再通知他（order-mail 也不订阅 order.delivered）。
 * @see app/auto-fulfilment.ts（自动签收，同一迁移的另一入口）；docs/自主决策记录.md AJ-387
 */
import type { Express } from 'express';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { AFTER_SALE_OPEN_STATUSES } from '@waselect/shared';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import { requireRole, type AuthConfig } from './auth.js';
import { withUnitOfWork } from './unit-of-work.js';

export interface ConfirmReceiptRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
  events: EventBus;
}

export function mountConfirmReceiptRoutes(app: Express, deps: ConfirmReceiptRoutesDeps): void {
  app.post(
    '/api/v1/orders/:id/confirm-receipt',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const orderId = String(req.params.id);
          const at = deps.clock.now();
          const status = await withUnitOfWork(deps.db, deps.events, async (tx, emit) => {
            const [row] = await tx`
              select status, has_dispute from orders
               where id = ${orderId} and user_id = ${sub} for update`;
            if (row === undefined) throw new AppError(40400, { order_id: orderId });
            const s = String(row['status']);
            if (s === 'delivered' || s === 'completed') return s;
            if (s !== 'shipped' || row['has_dispute'] === true) {
              throw new AppError(40902, {
                order_id: orderId,
                reason: row['has_dispute'] === true ? 'dispute_hold' : `status_${s}`,
              });
            }
            // 审计 BUG-09（2026-10-14，AJ-529）：有进行中的售后（买家报了"没收到 / 破损"）时不许签收——
            //   与自动签收作业（adapters/orders.ts autoAdvanceOrders）同一条件，两条签收路径同口径。
            //   reason 进 data：小程序据此说"售后处理中，结案后再确认"。
            const [openAs] = await tx`
              select 1 from after_sale_requests
               where order_id = ${orderId} and status in ${tx([...AFTER_SALE_OPEN_STATUSES])}`;
            if (openAs !== undefined) {
              throw new AppError(
                40902,
                { order_id: orderId, reason: 'after_sale_open' },
                { reason: 'after_sale_open' },
              );
            }
            await tx`
              update orders set status = 'delivered', delivered_at = ${at}, updated_at = now()
               where id = ${orderId}`;
            await tx`
              insert into order_events (order_id, status, note, actor, at)
              values (${orderId}, 'delivered', 'buyer_confirmed', ${`user:${sub}`}, ${at})`;
            emit({ name: 'order.delivered', at: at.toISOString(), orderId });
            return 'delivered';
          });
          deps.logger.info('order_receipt_confirmed', {
            result: 'ok',
            order_id: orderId,
            ctx: { status },
          });
          res.json({ order_id: orderId, status });
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
