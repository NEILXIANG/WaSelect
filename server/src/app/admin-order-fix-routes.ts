/**
 * 职责：管理端两条"手滑出口"（第三轮缺口 P1-11 / P1-10，AJ-386）。
 *
 * - `POST  /admin/orders/:id/cancel`   `{ reason }` → 200：取消**未付**订单（created / pending_payment）。
 * - `PATCH /admin/orders/:id/shipment` `{ carrier, tracking_no, reason }` → 200：改**已发货**订单的承运商 / 运单号。
 *
 * @why 取消：价格录错后，已建好的未付单原先只能等 30 分钟过期，或拉黑买家（连带取消，副作用过大）；
 *      停售开关挡不住"恢复接单后这张错价单照样能付"。直接复用买家取消的同一条用例（cancelOrder）：
 *      事务外先问机构"会话付了没有"（fail-closed），事务内迁移 + 作废支付行 + 回补库存，提交后发 `order.cancelled`
 *      （订阅者作废机构会话）。区别只在 actor（admin:<sub>）与事件 note（原因）。
 * @why 改运单号：发货后运单号原先不可改，唯一出路是改库（违背"不直连改库"），而错号已随发货邮件发出。
 *      只允许 shipped：delivered 之后再改没有意义（货已到），paid 还没发货（走发货）。
 *      改完重发一封发货邮件，幂等键带一次性 `mail_key`——否则服务商按 `order.shipped:<订单>` 去重，新邮件发不出去。
 * @limitation 改运单号不改 `shipped_at`：发货时刻是事实，改的只是单号。
 * @why 运单号在 shipInfoGuard 里归一（去空白、转大写，AJ-410）；事件 note 与审计 after 都记归一值。
 * @limitation 取消原因进 order_events.note 与 admin_audit；不通知买家（未付单没有付款邮件，买家在订单列表看到"已取消"）。
 * @see app/cancel-order.ts；domain/admin-order-actions.ts（shipInfoGuard / releaseReasonGuard）；契约 0.6.37
 */
import type { Express, Request } from 'express';
import { withTransaction, type Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { lockAdminOrder } from '../adapters/orders-admin.js';
import { releaseReasonGuard, shipInfoGuard } from '../domain/admin-order-actions.js';
import { trackingNoRecognized } from '../domain/tracking.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import type { IdGen } from '../ports/ids.js';
import type { PaymentRegistry } from '../ports/payment.js';
import { setAuditAfter, setAuditBefore } from './admin-audit.js';
import { requireRole, type AuthConfig } from './auth.js';
import { assertNoPaidSession, cancelOrder } from './cancel-order.js';
import { withUnitOfWork } from './unit-of-work.js';

export interface AdminOrderFixRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
  registry: PaymentRegistry;
  events: EventBus;
  /** 发货邮件重发的一次性 mail_key（F10：业务侧不自己摇 UUID）。 */
  idGen: IdGen;
}

const actorOf = (req: Request): string => `admin:${req.auth?.sub ?? 'unknown'}`;

export function mountAdminOrderFixRoutes(app: Express, deps: AdminOrderFixRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.post('/api/v1/admin/orders/:id/cancel', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const reason = releaseReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reason.ok) throw new AppError(reason.code, { reason: reason.reason, order_id: id });
        const [o] = await deps.db`select user_id from orders where id = ${id}`;
        if (o === undefined) throw new AppError(40400, { order_id: id });
        const userId = String(o['user_id']);
        // 事务外先问机构（与买家取消同一道 fail-closed 防线：查不到就不敢取消）
        await assertNoPaidSession(
          { db: deps.db, logger: deps.logger, registry: deps.registry },
          { orderId: id, userId },
        );
        await withUnitOfWork(deps.db, deps.events, async (tx, emit) => {
          await cancelOrder(
            tx,
            { clock: deps.clock, logger: deps.logger },
            { orderId: id, userId, actor: actorOf(req), note: reason.reason },
          );
          emit({ name: 'order.cancelled', at: deps.clock.now().toISOString(), orderId: id });
        });
        res.json({ order_id: id, status: 'cancelled' });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.patch('/api/v1/admin/orders/:id/shipment', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const ship = shipInfoGuard(req.body);
        if (!ship.ok) throw new AppError(ship.code, { reason: ship.reason, order_id: id });
        const reason = releaseReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reason.ok) throw new AppError(reason.code, { reason: reason.reason, order_id: id });
        const at = deps.clock.now();
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          if (row.status !== 'shipped') {
            throw new AppError(40902, { order_id: id, reason: `status_${row.status}` });
          }
          setAuditBefore(res, { carrier: row.carrier, tracking_no: row.tracking_no });
          await tx`
            update orders set carrier = ${ship.carrier}, tracking_no = ${ship.trackingNo}, updated_at = now()
             where id = ${id}
          `;
          await tx`
            insert into order_events (order_id, status, note, actor, at)
            values (${id}, 'shipment_fixed',
                    ${`${row.carrier ?? '-'} / ${row.tracking_no ?? '-'} → ${ship.carrier} / ${ship.trackingNo}；原因：${reason.reason}`},
                    ${actorOf(req)}, ${at})
          `;
        });
        // 审计 after 记落库的归一值（AJ-410：运单号在 shipInfoGuard 里归一，请求体与库不再是同一串）
        setAuditAfter(res, {
          carrier: ship.carrier,
          tracking_no: ship.trackingNo,
          reason: reason.reason,
        });
        deps.logger.info('admin_order_shipment_fixed', { result: 'ok', order_id: id });
        // 提交后重发发货邮件：一次性 mail_key 让服务商不把它当成首封的重放
        deps.events.publish({
          name: 'order.shipped',
          at: at.toISOString(),
          orderId: id,
          payload: { carrier: ship.carrier, mail_key: `fix-${deps.idGen.uuid()}` },
        });
        res.json({
          order_id: id,
          carrier: ship.carrier,
          tracking_no: ship.trackingNo,
          tracking_recognized: trackingNoRecognized(ship.carrier, ship.trackingNo),
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
