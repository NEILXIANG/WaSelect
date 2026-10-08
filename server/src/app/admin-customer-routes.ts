/**
 * 职责：管理端客户端点（AJ-404；对标分析 §4.5）——`GET /admin/customers`、`GET /admin/customers/{id}`，
 *       以及唯一的写操作 `DELETE /admin/customers/{id}/events`（AJ-413：APPI 删除行为记录）。
 *
 * @why 除删除行为记录外只读：拉黑 / 解除**复用** `/admin/users/{id}/block|unblock`（admin-risk-routes.ts）——
 *      同一件事两个入口各写一份，"连带取消在途单"与"作废身份缓存"这两条副作用迟早只剩一份在做。
 * @why 两条路由共用**一个** `requireRole` 守卫实例（与其余管理端路由同口径）。
 * @why 读客户资料**不进 admin_audit**（与订单详情同口径；审计中间件只记写操作，
 *      只有 CSV 导出这种"PII 批量出库"显式补审计——admin-export-routes.ts）。
 *      但写一条业务日志 `admin_customer_viewed`（只有 target_user_id，actor 由守卫写进上下文），
 *      回答"谁在什么时候看了哪个客户"；列表只记分页、命中数与"有没有关键字"——**关键字本身不记**：
 *      运营搜的往往就是邮箱或姓名（约束七脱敏红线）。
 * @why 响应里**没有 openid**：它是微信侧的身份凭据，后台用不上，下发只会多一个泄露面。
 * @limitation 一：参数错误的 reason 只进日志（`AppError.details` → `request_rejected`），与全站口径一致，不进响应体。
 * @limitation 二：管理员 id 按"不存在"处理（40403），不单设一个码——管理员不是客户，没有"可看"的客户资料。
 *
 * @see adapters/customers-admin.ts（口径表）；domain/customer-query.ts（参数判定）；
 *      contracts/api-contract.yaml 0.6.47（AdminCustomerListItem / AdminCustomer）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { requireRole } from './auth.js';
import { withTransaction } from '../adapters/db.js';
import { purgeUserEventsByUser } from '../adapters/user-events.js';
import { purgeReasonGuard } from '../domain/admin-order-actions.js';
import { parseCustomerListQuery } from '../domain/customer-query.js';
import {
  countCustomerDisputes,
  findCustomer,
  listCustomerAddresses,
  listCustomerOrders,
  listCustomers,
  type CustomerListRow,
} from '../adapters/customers-admin.js';

export interface AdminCustomerRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
/** 可空字段：null 一律**省略键**（不填空串 / 0），与 admin-risk-routes 的 toDispute 同口径。 */
function opt(key: string, v: string | null): Record<string, string> {
  return v === null ? {} : { [key]: v };
}

/** 列表行 → 契约 `AdminCustomerListItem`。 */
function toListItem(r: CustomerListRow): Record<string, unknown> {
  return {
    id: r.id,
    created_at: r.createdAt.toISOString(),
    blocked: r.blockedAt !== null,
    ...opt('blocked_at', iso(r.blockedAt)),
    order_count: r.stats.orderCount,
    paid_order_count: r.stats.paidOrderCount,
    paid_total_jpy: r.stats.paidTotalJpy,
    ...opt('last_order_at', iso(r.stats.lastOrderAt)),
    ...opt('contact_email', r.contactEmail),
    ...opt('last_recipient', r.lastRecipient),
  };
}

export function mountAdminCustomerRoutes(app: Express, deps: AdminCustomerRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.get('/api/v1/admin/customers', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = parseCustomerListQuery(req.query as Record<string, unknown>);
        if (!q.ok) throw new AppError(40001, { reason: q.reason });
        const { items, total } = await listCustomers(deps.db, q);
        deps.logger.info('admin_customers_listed', {
          result: 'ok',
          ctx: { page: q.page, size: q.size, has_keyword: q.keyword !== null, total },
        });
        res.json({ items: items.map(toListItem), total });
      } catch (e) {
        next(e);
      }
    })();
  });

  /**
   * APPI「用户要求删除」的后台路径（AJ-413，契约 0.6.51）：删掉该客户在 `user_events` 里的全部行。
   * @why 原因必填且进审计：`admin_audit` 中间件把请求体记成 after（`{reason}`）、路径 id 记成 target——
   *      "谁、什么时候、应谁的要求删了谁的记录"全在一行里。
   * @why 没有记录也回 200 {deleted: 0} 并照样留审计：删除请求已兑现，这件事本身要可证明。
   * @why 不删订单 / 地址 / 审计：账务字段有保存义务，走匿名化（AJ-292）；这里只管行为流。
   */
  app.delete('/api/v1/admin/customers/:id/events', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const reason = purgeReasonGuard((req.body as { reason?: unknown } | null)?.reason);
        if (!reason.ok) throw new AppError(reason.code, { reason: reason.reason });
        const c = await findCustomer(deps.db, id);
        if (c === null) throw new AppError(40403, { target_user_id: id });
        const deleted = await withTransaction(deps.db, (tx) => purgeUserEventsByUser(tx, id));
        deps.logger.info('admin_user_events_purged', {
          result: 'ok',
          ctx: { target_user_id: id, count: deleted },
        });
        res.json({ deleted });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/customers/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const c = await findCustomer(deps.db, id);
        if (c === null) throw new AppError(40403, { target_user_id: id });
        const [addresses, orders, disputes] = await Promise.all([
          listCustomerAddresses(deps.db, id),
          listCustomerOrders(deps.db, id),
          countCustomerDisputes(deps.db, id),
        ]);
        deps.logger.info('admin_customer_viewed', { result: 'ok', ctx: { target_user_id: id } });
        res.json({
          id: c.id,
          created_at: c.createdAt.toISOString(),
          blocked: c.blockedAt !== null,
          ...opt('blocked_at', iso(c.blockedAt)),
          ...opt('contact_email', c.contactEmail),
          stats: {
            order_count: c.stats.orderCount,
            paid_order_count: c.stats.paidOrderCount,
            paid_total_jpy: c.stats.paidTotalJpy,
            test_order_count: c.stats.testOrderCount,
            ...opt('first_order_at', iso(c.stats.firstOrderAt)),
            ...opt('last_order_at', iso(c.stats.lastOrderAt)),
          },
          addresses: addresses.map((a) => ({
            id: a.id,
            recipient: a.recipient,
            phone: a.phone,
            line1: a.line1,
            ...opt('line2', a.line2),
            city: a.city,
            state: a.state,
            postal_code: a.postalCode,
            country: a.country,
            is_default: a.isDefault,
          })),
          orders: orders.map((o) => ({
            order_id: o.id,
            order_no: o.orderNo,
            status: o.status,
            total_jpy: o.totalJpy,
            is_test: o.isTest,
            has_dispute: o.hasDispute,
            created_at: o.createdAt.toISOString(),
            ...opt('paid_at', iso(o.paidAt)),
          })),
          risk: { dispute_count: disputes.total, open_dispute_count: disputes.open },
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
