/**
 * 职责：`POST /orders` 与 `POST /orders/{id}/cancel` 路由薄壳（I1-U5b/U5c）——
 *      HTTP 形状校验 + 幂等包装 + 调建单/取消核心。
 *
 * @why 幂等（Idempotency-Key 必带）在薄壳而不在核心：幂等键的生命周期是"一次 HTTP 意图"，
 *      核心 `createOrder` 只懂"在事务里建一张单"。runInTx 的占位+业务写+结果写回
 *      同事务模式（N2/N3）在骨架期已被验证，本路由是它的第一个业务消费方（骨架已随 U6c 退役）。
 *
 * @why 限流只挂 **POST /orders**（publicWrite，30 次/分钟/IP）而不是整个 /orders 前缀：
 *      同前缀下的 GET /orders、GET /orders/{id}（U5c）是高频只读，被写路径的配额
 *      误伤不可接受；Express 按方法+路径匹配，本文件把 limiter 放进 post 的中间件链。
 *      取消也不挂：低频本人写路径，与地址 CRUD 同口径（AJ-108）。
 *
 * @why 取消**不要** Idempotency-Key：它的天然幂等键就是状态机——第二次取消撞
 *      迁移表（cancelled 是终态）→ 40902，语义比"重放返回旧结果"更清楚。
 *      契约也没有给它声明 IdemKey 参数。
 *
 * @limitation 一：Idempotency-Key 的长度上限（≤128）已在 `ports/idempotency.ts` 的 `scopeKey` 统一拒绝
 *              （超限 40001 + reason idempotency_key_too_long，契约 0.6.0②；一致性审计 C9 更正原"暂不限长"）。
 * @limitation 二：响应的 display/fx_snapshot 直接用重算结果——客户端看到的确认页
 *              与建单返回必然一致（同一事务、同一次 fx 查询）。
 *
 * @see app/create-order.ts（建单核心）；app/cancel-order.ts（取消核心）；
 *      app/quote-routes.ts（parseItems 共用形状校验）；
 *      contracts/api-contract.yaml（OrderCreated）；docs/I1阶段开发实施方案.md §3.5
 */
import type { Express, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { AppConfig } from '../config.js';
import type { EventBus, DomainEvent } from '../ports/events.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { scopeKey, type IdempotencyExecutor } from '../ports/idempotency.js';
import { createOrder } from './create-order.js';
import { cancelOrder } from './cancel-order.js';
import { withUnitOfWork } from './unit-of-work.js';
import { parseItems } from './quote-routes.js';

export interface OrderRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  idGen: IdGen;
  config: AppConfig;
  auth: AuthConfig;
  identity?: IdentityCheck | undefined;
  idempotency: IdempotencyExecutor<Db>;
  events: EventBus;
  /** 限流中间件（装配处按 rateLimitRules.publicWrite 生成后传入；挂载点统一在 mount.ts）。 */
  createOrderLimiter: RequestHandler;
}

/** 建单请求体的 items 之外部分（形状校验；语义校验在核心）。 */
function parseBody(body: unknown): {
  addressId: string;
  termsVersion: string | undefined;
  expectedTotalJpy: number | undefined;
  contactEmail: string | undefined;
} {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object') throw new AppError(40001, { reason: 'body_shape' });
  if (typeof b['address_id'] !== 'string' || b['address_id'].length === 0) {
    throw new AppError(40001, { reason: 'address_id_required' });
  }
  if (b['terms_version'] !== undefined && typeof b['terms_version'] !== 'string') {
    throw new AppError(40001, { reason: 'terms_version_shape' });
  }
  if (b['expected_total_jpy'] !== undefined && !Number.isInteger(b['expected_total_jpy'])) {
    throw new AppError(40001, { reason: 'expected_total_jpy_shape' });
  }
  if (b['contact_email'] !== undefined) {
    // 形状 + 长度在入口拦（全量审计 2026-09-26）：列是 VARCHAR(255)，超长会以 PG 22001 → 50000 暴露，
    // 而它是客户端可控输入，应是 40001；格式只做最低限度（有 @、无空白），不发明邮箱正则
    const email = b['contact_email'];
    if (
      typeof email !== 'string' ||
      email.length === 0 ||
      email.length > 255 ||
      !/^[^\s@]+@[^\s@]+$/.test(email)
    ) {
      throw new AppError(40001, { reason: 'contact_email_shape' });
    }
  }
  return {
    addressId: b['address_id'] as string,
    termsVersion: b['terms_version'] as string | undefined,
    expectedTotalJpy: b['expected_total_jpy'] as number | undefined,
    contactEmail: b['contact_email'] as string | undefined,
  };
}

export function mountOrderRoutes(app: Express, deps: OrderRoutesDeps): void {
  app.post(
    '/api/v1/orders',
    deps.createOrderLimiter,
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);

          const clientKey = req.header('idempotency-key');
          if (clientKey === undefined || clientKey.trim().length === 0) {
            throw new AppError(40001, { reason: '缺少 Idempotency-Key 头' });
          }

          const items = parseItems(req.body);
          const parsed = parseBody(req.body);

          // 提交后才分发（重放时 handler 不执行、列表为空，天然不会重复发）
          const pendingEvents: DomainEvent[] = [];
          const result = await deps.idempotency.runInTx(
            {
              key: scopeKey({ userId: sub, route: 'orders.create', clientKey }),
              userId: sub,
              route: 'orders.create',
              // N3：指纹素材必传——不传则 40908 是死代码（客户端复用键的 bug 被静默吞掉）
              request: req.body,
              logger: deps.logger,
            },
            async (tx) => {
              const created = await createOrder(
                tx,
                {
                  config: deps.config,
                  clock: deps.clock,
                  idGen: deps.idGen,
                  logger: deps.logger,
                },
                {
                  userId: sub,
                  items,
                  addressId: parsed.addressId,
                  termsVersion: parsed.termsVersion,
                  expectedTotalJpy: parsed.expectedTotalJpy,
                  contactEmail: parsed.contactEmail,
                },
              );
              pendingEvents.push({
                name: 'order.created',
                at: deps.clock.now().toISOString(),
                orderId: created.orderId,
                payload: { order_no: created.orderNo },
              });
              const { q } = created;
              return {
                status: 201,
                body: {
                  items_jpy: q.itemsJpy,
                  shipping_jpy: q.shippingJpy,
                  duty_jpy: q.dutyJpy,
                  duty_estimate: q.dutyEstimated,
                  total_jpy: q.totalJpy,
                  weight_g: q.weightG,
                  display: q.display,
                  ...(q.freeShippingRemainingJpy !== null
                    ? { free_shipping_remaining_jpy: q.freeShippingRemainingJpy }
                    : {}),
                  split_hint: q.splitHint,
                  order_id: created.orderId,
                  order_no: created.orderNo,
                  fx_snapshot: created.fxSnapshot,
                  status: 'created' as const,
                  expires_at: created.expiresAt.toISOString(),
                },
              };
            },
          );
          deps.events.publishAll(pendingEvents);
          res.status(result.status).json(result.body);
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  // ── 取消（I1-U5c）：无 Idempotency-Key——状态机就是天然幂等键（文件头 @why）──
  app.post(
    '/api/v1/orders/:id/cancel',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const raw = req.params['id'];
          const orderId = typeof raw === 'string' ? raw : '';
          if (orderId.length === 0) throw new AppError(40001, { reason: 'order_id_required' });
          await withUnitOfWork(deps.db, deps.events, async (tx, emit) => {
            await cancelOrder(
              tx,
              { clock: deps.clock, logger: deps.logger },
              { orderId, userId: sub },
            );
            // 提交后才分发（withUnitOfWork 的位置保证）；重放撞 40902 到不了这里
            emit({ name: 'order.cancelled', at: deps.clock.now().toISOString(), orderId });
          });
          res.status(200).json({ ok: true });
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
