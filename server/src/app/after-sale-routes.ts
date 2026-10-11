/**
 * 职责：售后申请两条写路由（AJ-420，契约 0.6.56）。
 *
 * - `POST /api/v1/orders/:id/after-sales` `{ reason, description }`（买家）→ 201 `{ after_sale }`
 * - `POST /api/v1/admin/orders/:id/after-sales/:rid/resolve` `{ status, note? }`（运营）→ 200 `{ after_sale }`
 *
 * 读在订单详情里带：买家 `GET /orders/:id` 的 `after_sale`（最新一条），管理端 `GET /admin/orders/:id` 的 `after_sales`。
 *
 * @why "已有进行中"**只靠部分唯一索引**判（插入撞 `uq_after_sale_requests_open` → 40902 after_sale_open），
 *      不先查再插：先查再插在两个并发请求下两边都"查不到"，判断就漏了；索引是唯一不会漏的那道。
 * @why 锁订单行（for update）是为了**状态判断**：同一时刻运营在退款 / 改状态，买家不能基于旧状态申请成功。
 * @why 40902 的 reason 放进 `data`（对外）：小程序据此说"已有进行中的申请"并刷新详情，而不是笼统的"操作失败"。
 * @why 别人的单与不存在同为 40400（与订单详情 / 确认收货同口径）。
 * @why 运营改状态的审计**不手写**：`/api/v1/admin` 前缀的审计中间件自动记（含请求体）——这也是
 *      "处理历史只留最后一次"（迁移 038 @limitation 一）的追溯来源。
 * @why 日志不带 description / note：那是买家 / 运营写的原话，可能含电话地址（约束七）。
 * @limitation 一：不通知——买家提交后运营要在后台订单详情里看到（工作台待办另议）；运营处理后买家要自己打开订单详情看进度。
 * @limitation 二：不联动退款 / 补发：处理结果是一句说明；要退款仍走部分退款 / 整单退款（钱的流程不与售后耦合）。
 * @see adapters/after-sales.ts；domain/after-sale-input.ts；packages/shared/src/after-sale.ts
 */
import type { Express, Request } from 'express';
import {
  AFTER_SALE_STATUS_LABELS,
  AFTER_SALE_ORDER_STATUSES,
  afterSaleTransitionAllowed,
  type AfterSaleStatus,
} from '@waselect/shared';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import {
  insertAfterSale,
  lockAfterSale,
  updateAfterSale,
  type AfterSaleRow,
} from '../adapters/after-sales.js';
import { parseAfterSaleInput, parseAfterSaleResolve } from '../domain/after-sale-input.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { EventBus } from '../ports/events.js';
import { requireRole, type AuthConfig } from './auth.js';
import { withUnitOfWork } from './unit-of-work.js';

export interface AfterSaleRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
  idGen: IdGen;
  /** 只为复用 withUnitOfWork 的事务封装；本模块不发事件。 */
  events: EventBus;
}

/** 买家视角：不带处理人。可选字段没有值时**省略**键。 */
export function buyerAfterSaleView(a: AfterSaleRow): Record<string, unknown> {
  return {
    id: a.id,
    reason: a.reason,
    description: a.description,
    status: a.status,
    ...(a.resolution_note !== null ? { resolution_note: a.resolution_note } : {}),
    created_at: a.created_at.toISOString(),
    updated_at: a.updated_at.toISOString(),
  };
}

/** 运营视角：多一个处理人。 */
export function adminAfterSaleView(a: AfterSaleRow): Record<string, unknown> {
  return {
    ...buyerAfterSaleView(a),
    ...(a.handled_by !== null ? { handled_by: a.handled_by } : {}),
  };
}

const conflict = (orderId: string, reason: string): AppError =>
  new AppError(40902, { order_id: orderId, reason }, { reason });

const routeParam = (req: Request, k: string): string => String(req.params[k] ?? '');

export function mountAfterSaleRoutes(app: Express, deps: AfterSaleRoutesDeps): void {
  app.post(
    '/api/v1/orders/:id/after-sales',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const orderId = routeParam(req, 'id');
          const input = parseAfterSaleInput(req.body);
          const at = deps.clock.now();
          const row = await withUnitOfWork(deps.db, deps.events, async (tx) => {
            const [o] = await tx`
              select status from orders where id = ${orderId} and user_id = ${sub} for update`;
            if (o === undefined) throw new AppError(40400, { order_id: orderId });
            const status = String(o['status']);
            if (!(AFTER_SALE_ORDER_STATUSES as readonly string[]).includes(status)) {
              throw conflict(orderId, 'status_not_allowed');
            }
            const ins = await insertAfterSale(tx, {
              id: deps.idGen.uuid(),
              orderId,
              userId: sub,
              reason: input.reason,
              description: input.description,
              at,
            });
            if (ins === null) throw conflict(orderId, 'after_sale_open');
            return ins;
          });
          deps.logger.info('after_sale_requested', {
            result: 'ok',
            order_id: orderId,
            ctx: { after_sale_id: row.id, reason: row.reason },
          });
          res.status(201).json({ after_sale: buyerAfterSaleView(row) });
        } catch (e) {
          if (e instanceof AppError && e.code === 40902) {
            deps.logger.info('after_sale_rejected', {
              order_id: routeParam(req, 'id'),
              reason: String((e.details as { reason?: string } | undefined)?.reason),
            });
          }
          next(e);
        }
      })();
    },
  );

  app.post(
    '/api/v1/admin/orders/:id/after-sales/:rid/resolve',
    requireRole('admin', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const orderId = routeParam(req, 'id');
          const rid = routeParam(req, 'rid');
          const input = parseAfterSaleResolve(req.body);
          const at = deps.clock.now();
          const row = await withUnitOfWork(deps.db, deps.events, async (tx) => {
            const cur = await lockAfterSale(tx, orderId, rid);
            if (cur === null) throw new AppError(40400, { order_id: orderId, after_sale_id: rid });
            if (!afterSaleTransitionAllowed(cur.status, input.status as AfterSaleStatus)) {
              throw conflict(
                orderId,
                cur.status === 'open' || cur.status === 'processing'
                  ? 'transition_invalid'
                  : 'after_sale_closed',
              );
            }
            const updated = await updateAfterSale(tx, {
              id: rid,
              status: input.status,
              note: input.note,
              handledBy: `admin:${req.auth?.sub ?? 'unknown'}`,
              at,
            });
            // ADM-5（AJ-452）：处理过程进订单时间线（伪状态 after_sale_handled；买家时间线只认订单状态值，不会外泄）。
            //   售后表只保留最后一次处理结果（038 @limitation 一），没有这条，"何时谁把它改成处理中"只能翻审计。
            await tx`
              insert into order_events (order_id, status, note, actor, at)
              values (${orderId}, 'after_sale_handled',
                      ${`${AFTER_SALE_STATUS_LABELS[input.status as AfterSaleStatus]}${input.note === null || input.note === undefined ? '' : `：${input.note}`}（售后 #${rid}）`},
                      ${`admin:${req.auth?.sub ?? 'unknown'}`}, ${at})`;
            return updated;
          });
          deps.logger.info('after_sale_resolved', {
            result: 'ok',
            order_id: orderId,
            ctx: { after_sale_id: rid, status: row.status },
          });
          res.json({ after_sale: adminAfterSaleView(row) });
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
