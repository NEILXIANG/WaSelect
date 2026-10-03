/**
 * 职责：订单**读路径**路由薄壳（I1-U5c）——`GET /orders`（status 过滤）与 `GET /orders/{id}`。
 *
 * @why 与写路径（order-routes.ts）分文件：读路径高频、无幂等/限流包袱，
 *      写路径有幂等键与限流中间件——两类路由的"厚度"不同，塞一个文件里
 *      会让读路径被迫 import 一堆它不需要的东西。
 *
 * @why 不挂限流：本人的只读列表/详情，被写路径配额误伤不可接受（order-routes @why），
 *      单独给读路径开配额是 U7 之后有真实流量数据再定的事。
 *
 * @limitation 一：status 过滤的合法值 = shared `ORDER_STATUS` 10 态全集（契约 0.5.5 起
 *              双词表统一；旧的 unpaid/closed 五值 UI 词已废——unpaid ≈ created+pending_payment
 *              由前端各查一次或不过滤，closed ≈ cancelled+expired 同理）。
 * @limitation 二：无分页（契约无 page/size 参数，adapters/orders.ts @limitation 同口径）。
 *
 * @see app/order-views.ts（响应映射）；adapters/orders.ts（取数）；docs/I1阶段开发实施方案.md §3.5
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { AppConfig } from '../config.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import {
  findLatestPaymentSummary,
  findOwnedOrder,
  listOrderItemsWithImage,
  listOrderTimeline,
  listOwnedOrders,
} from '../adapters/orders.js';
import { isOneOf, ORDER_STATUS } from '@waselect/shared';
import type { DisplayCurrency } from '../domain/quote.js';
import { toOrderDetail, toOrderSummary } from './order-views.js';

export interface OrderQueryRoutesDeps {
  db: Db;
  config: AppConfig;
  auth: AuthConfig;
  /** 身份状态查询（D25）。**必填**，理由见 {@link requireRole} 的 `@param identity`（app/auth.ts）。 */
  identity: IdentityCheck;
}

export function mountOrderQueryRoutes(app: Express, deps: OrderQueryRoutesDeps): void {
  const displayCurrencies = deps.config.DISPLAY_CURRENCIES.filter(
    (c): c is DisplayCurrency => c !== 'JPY',
  );
  const guard = requireRole('user', deps.auth, { identity: deps.identity });

  app.get('/api/v1/orders', guard, (req, res, next) => {
    void (async () => {
      try {
        const sub = req.auth?.sub;
        if (sub === undefined) throw new AppError(40101);
        const raw = req.query['status'];
        if (raw !== undefined && (typeof raw !== 'string' || !isOneOf(ORDER_STATUS, raw))) {
          throw new AppError(40001, { reason: 'status_invalid', status: raw });
        }
        const rows = await listOwnedOrders(deps.db, sub, raw);
        res.status(200).json({ items: rows.map((r) => toOrderSummary(r, displayCurrencies)) });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/orders/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const sub = req.auth?.sub;
        if (sub === undefined) throw new AppError(40101);
        const raw = req.params['id'];
        const orderId = typeof raw === 'string' ? raw : '';
        const order = await findOwnedOrder(deps.db, orderId, sub);
        // 非本人与不存在同码（40400）：分开会泄露"这单存在但是别人的"
        if (order === null) throw new AppError(40400, { order_id: orderId });
        const [items, timeline, payment] = await Promise.all([
          listOrderItemsWithImage(deps.db, orderId),
          listOrderTimeline(deps.db, orderId),
          findLatestPaymentSummary(deps.db, orderId),
        ]);
        res.status(200).json(toOrderDetail(order, { items, timeline, payment }, displayCurrencies));
      } catch (e) {
        next(e);
      }
    })();
  });
}
