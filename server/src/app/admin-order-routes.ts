/**
 * 职责：管理端订单端点（I2 U-B2d）——`GET /admin/orders`、`GET /admin/orders/{id}`、
 *      `POST /admin/orders/{id}/ship`、`/refund`、`/address`。
 *
 * @why 五条路由共用**一个** `requireAdmin` 守卫实例（与 admin-product-routes 同口径）：
 *      守卫抄五遍，"将来要不要加一条审计"就得改五处，漏一处就是
 *      "某条管理端接口没守卫"——而这种漏法不会报错，只会静默地裸露。
 *
 * @why 响应里的订单主键叫 **`order_id`** 而不是 `id`（契约 `OrderSummary` 的字段名）：
 *      前端的形状断言**硬失败**在缺 `order_id` 上（`admin-web/src/orders/api.ts`
 *      @limitation 一），叫错名字的表现是"整页空白 + 网络错误"，
 *      而真因只是键名——这类错最贵的地方在于它指向完全错误的排查方向。
 *
 * @limitation 一：三个写操作都是"**事务内持锁判定 + 迁移**，**事务外调机构**"。
 *              退款的机构调用（`provider.refund`）绝不能在事务里做：
 *              事务持着 orders 行锁去等一个外部 HTTP，等于把数据库的行锁时长
 *              押在别人的响应时间上。代价是"迁移成功、机构调用失败"会留下
 *              一个停在 `refunding` 的订单（看得见、可捞、可人工重试），
 *              而不是"整单回滚、钱货对不上但没人知道"（AJ-146）。
 * @limitation 二：`includeTest` **不在路由上开放**（仓储支持、路由不接）：
 *              契约只声明了 status / keyword / page / size，而管理端目前没有
 *              "显示测试单"的开关。等要加开关的那天**先改契约再开参数**——
 *              顺序不能倒（否则又是"契约比实现严格"的漂移）。
 *              ⚠️ 因此"按单号搜测试单"仍然可用（keyword 会绕过 is_test 过滤，
 *              见 `orders-admin.ts` @limitation 三），只是列表里默认看不到。
 * @limitation 三：改址后的快照 `id` 恒为 **null**：它表示"这条地址来自哪个地址簿条目"，
 *              而管理员手改出来的地址**不属于任何一条地址簿记录**——
 *              沿用旧 id 会让快照声称自己等于一个它已经不等于的地址。
 *
 * @see adapters/orders-admin.ts（仓储）；domain/admin-order-actions.ts（准入判定）；
 *      domain/address-input.ts（地址校验）；contracts/api-contract.yaml（AdminOrder / AdminOrderListItem）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import { withTransaction } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../ports/clock.js';
import type { PaymentRegistry, RefundRequest } from '../ports/payment.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { ORDER_STATUS } from '@waselect/shared';
import { asOrderStatus } from '../domain/order.js';
import { addressGuard, refundGuard, shipGuard } from '../domain/admin-order-actions.js';
import { parseAddressInput } from '../domain/address-input.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import {
  findAdminOrder,
  findRefundablePayment,
  listAdminOrders,
  listEventsFor,
  listOrderItemsFor,
  listPaymentsFor,
  lockAdminOrder,
  markRefunded,
  markRefunding,
  markShipped,
  updateAddressSnapshot,
  type AdminOrderListRow,
  type AdminOrderRow,
} from '../adapters/orders-admin.js';

export interface AdminOrderRoutesDeps {
  db: Db;
  logger: Logger;
  config: AppConfig;
  auth: AuthConfig;
  identity: IdentityCheck;
  clock: Clock;
  registry: PaymentRegistry;
}

/** 列表行 → 契约 `AdminOrderListItem`（主键改叫 order_id，见文件头 @why）。 */
function toListItem(r: AdminOrderListRow): Record<string, unknown> {
  return {
    order_id: r.id,
    order_no: r.order_no,
    user_id: r.user_id,
    status: r.status,
    total_jpy: r.total_jpy,
    ...(r.contact_email !== null ? { contact_email: r.contact_email } : {}),
    ...(r.carrier !== null ? { carrier: r.carrier } : {}),
    ...(r.tracking_no !== null ? { tracking_no: r.tracking_no } : {}),
    has_dispute: r.has_dispute,
    is_test: r.is_test,
    created_at: r.created_at.toISOString(),
  };
}

/** 详情 → 契约 `AdminOrder`（= Order + 管理端专有块）。 */
function toAdminOrder(
  r: AdminOrderRow,
  items: readonly Record<string, unknown>[],
  payments: readonly Record<string, unknown>[],
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const latest = payments[payments.length - 1] as { charge_currency?: unknown } | undefined;
  return {
    order_id: r.id,
    order_no: r.order_no,
    user_id: r.user_id,
    status: r.status,
    items_jpy: r.items_jpy,
    shipping_jpy: r.shipping_jpy,
    duty_jpy: r.duty_jpy,
    total_jpy: r.total_jpy,
    items,
    address: r.address_snapshot,
    fx_snapshot: r.fx_snapshot,
    terms_version: r.terms_version,
    expires_at: r.expires_at.toISOString(),
    created_at: r.created_at.toISOString(),
    has_dispute: r.has_dispute,
    is_test: r.is_test,
    payments,
    events,
    // `payment` 是契约 Order 里的"最新一条摘要"；与 payments 末条同源，不另查一次。
    ...(latest !== undefined ? { payment: latest } : {}),
    ...(r.contact_email !== null ? { contact_email: r.contact_email } : {}),
    ...(r.carrier !== null ? { carrier: r.carrier } : {}),
    ...(r.tracking_no !== null ? { tracking_no: r.tracking_no } : {}),
    ...(r.paid_at !== null ? { paid_at: r.paid_at.toISOString() } : {}),
    ...(r.shipped_at !== null ? { shipped_at: r.shipped_at.toISOString() } : {}),
  };
}

/** 分页参数校验（契约：page 默认 1，size 默认 20、最大 100）。 */
function readPaging(q: { page?: unknown; size?: unknown }): { page: number; size: number } {
  const page = q.page === undefined ? 1 : Number(q.page);
  const size = q.size === undefined ? 20 : Number(q.size);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) {
    throw new AppError(40001, { reason: 'page_size_invalid' });
  }
  return { page, size };
}

export function mountAdminOrderRoutes(app: Express, deps: AdminOrderRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const countryProfiles = createCountryProfileRepo(deps.db);

  app.get('/api/v1/admin/orders', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = req.query as {
          status?: unknown;
          keyword?: unknown;
          page?: unknown;
          size?: unknown;
        };
        const { page, size } = readPaging(q);
        const status = q.status === undefined ? undefined : String(q.status);
        if (status !== undefined && !(ORDER_STATUS as readonly string[]).includes(status)) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        const rawKw = q.keyword === undefined ? undefined : String(q.keyword).trim();
        const { items, total } = await listAdminOrders(deps.db, {
          page,
          size,
          ...(status !== undefined ? { status } : {}),
          ...(rawKw !== undefined && rawKw !== '' ? { keyword: rawKw } : {}),
        });
        res.json({ items: items.map(toListItem), total });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.get('/api/v1/admin/orders/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const order = await findAdminOrder(deps.db, id);
        if (order === null) throw new AppError(40400, { order_id: id });
        // 三类附属数据各**一次**批量查询（本页只有一张单，但形态与列表将来共用）
        const [items, payments, events] = await Promise.all([
          listOrderItemsFor(deps.db, [id]),
          listPaymentsFor(deps.db, [id]),
          listEventsFor(deps.db, [id]),
        ]);
        res.json(
          toAdminOrder(
            order,
            items.map((i) => ({
              product_id: i.product_id,
              title: i.title_snapshot,
              qty: i.qty,
              unit_price_jpy: i.unit_price_jpy,
            })),
            payments.map((p) => ({
              provider: p.provider,
              status: p.status,
              charge_currency: p.charge_currency,
              charge_amount: p.charge_amount,
              ...(p.provider_ref !== null ? { provider_ref: p.provider_ref } : {}),
              ...(p.transaction_id !== null ? { transaction_id: p.transaction_id } : {}),
              ...(p.settled_jpy !== null ? { settled_jpy: p.settled_jpy } : {}),
              ...(p.fee_jpy !== null ? { fee_jpy: p.fee_jpy } : {}),
              created_at: p.created_at.toISOString(),
            })),
            events.map((e) => ({
              status: e.status,
              ...(e.note !== null ? { note: e.note } : {}),
              ...(e.actor !== null ? { actor: e.actor } : {}),
              at: e.at.toISOString(),
            })),
          ),
        );
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/ship', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const b = req.body as { carrier?: unknown; tracking_no?: unknown } | null;
        const carrier = typeof b?.carrier === 'string' ? b.carrier.trim() : '';
        const trackingNo = typeof b?.tracking_no === 'string' ? b.tracking_no.trim() : '';
        if (carrier === '' || trackingNo === '') {
          throw new AppError(40001, { reason: 'carrier_tracking_no_required' });
        }
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = shipGuard(asOrderStatus(row.status), row.has_dispute);
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          if (!(await markShipped(tx, id, carrier, trackingNo, deps.clock.now()))) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
        });
        deps.logger.info('admin_order_shipped', { result: 'ok', order_id: id });
        res.json({ order_id: id, status: 'shipped', carrier, tracking_no: trackingNo });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/refund', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const reason = (req.body as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string' || reason.trim() === '') {
          throw new AppError(40001, { reason: 'refund_reason_required' });
        }
        // ── 第一段（事务内）：持锁判定 → 落 refunding（AJ-146：先记账再对外）──
        const plan = await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = refundGuard(asOrderStatus(row.status), row.has_dispute);
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          const pay = await findRefundablePayment(tx, id);
          if (pay === null) {
            throw new AppError(40902, { order_id: id, reason: 'no_succeeded_payment' });
          }
          if (pay.provider_ref === null) {
            throw new AppError(50000, { order_id: id, reason: 'provider_ref_missing' });
          }
          if (!(await markRefunding(tx, id, reason.trim(), deps.clock.now()))) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
          // ⚠️ 在这里把已收窄的 providerRef 带出去：出了这个闭包 TS 的收窄就丢了，
          //    而 `RefundRequest.providerRef` 是 `string`——不带上就得在调用点再判一次
          //    （或用 `!`，那等于把"这里不可能为 null"的论证从类型里拿掉）。
          return { row, pay, providerRef: pay.provider_ref };
        });

        // ── 第二段（事务外）：调机构。失败不回滚——停在 refunding 是**可见**的状态 ──
        const provider = deps.registry.getForRefund(plan.pay.provider);
        const refundReq: RefundRequest = {
          orderId: id,
          providerRef: plan.providerRef,
          amountJpy: plan.row.total_jpy,
          currency: plan.pay.charge_currency,
          amountMinor: plan.pay.charge_amount,
          reason: reason.trim(),
        };
        const out = await provider.refund?.(refundReq);
        if (out === undefined) {
          throw new AppError(50000, { order_id: id, reason: 'refund_not_supported' });
        }
        if (out.outcome === 'failed') {
          deps.logger.error('admin_order_refund_failed', {
            result: 'failed',
            order_id: id,
            ctx: { provider: plan.pay.provider },
          });
          throw new AppError(50000, { order_id: id, reason: 'refund_failed' });
        }
        if (out.outcome === 'succeeded') {
          await withTransaction(deps.db, async (tx) => {
            await markRefunded(tx, id, plan.pay.id, out.refundRef, deps.clock.now());
          });
        }
        // pending：留在 refunding，等机构异步完成（F12 售后对账补"退款状态查询/回调"）
        deps.logger.info('admin_order_refund_accepted', {
          result: 'ok',
          order_id: id,
          ctx: { outcome: out.outcome },
        });
        res.status(202).json({ order_id: id, outcome: out.outcome });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/address', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const input = parseAddressInput(req.body);
        // 国家：表驱动的"可下单目的国"（与买家地址簿同一份校验链，只补这一步）
        const profile = await countryProfiles.get(input.country);
        if (profile === null || !profile.active) {
          throw new AppError(40002, { field: 'country', country: input.country });
        }
        // 快照 = 纯地址值：不带 is_default（订单快照没有"默认"），id 恒 null（@limitation 三）
        const snapshot = {
          id: null,
          recipient: input.recipient,
          phone: input.phone,
          line1: input.line1,
          line2: input.line2,
          city: input.city,
          state: input.state,
          postal_code: input.postal_code,
          country: input.country,
        };
        await withTransaction(deps.db, async (tx) => {
          const row = await lockAdminOrder(tx, id);
          if (row === null) throw new AppError(40400, { order_id: id });
          const gate = addressGuard(asOrderStatus(row.status));
          if (!gate.ok) throw new AppError(gate.code, { order_id: id, reason: gate.reason });
          if (
            !(await updateAddressSnapshot(
              tx,
              id,
              snapshot as never,
              `admin:${req.auth?.sub ?? 'unknown'}`,
              deps.clock.now(),
            ))
          ) {
            throw new AppError(40902, { order_id: id, reason: 'status_raced' });
          }
        });
        deps.logger.info('admin_order_address_changed', { result: 'ok', order_id: id });
        res.json({ order_id: id, address: snapshot });
      } catch (e) {
        next(e);
      }
    })();
  });
}
