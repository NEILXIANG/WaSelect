/**
 * 职责：`POST /orders/{id}/pay` 路由薄壳（I1-U6a）——HTTP 形状校验 + 幂等包装 +
 *      调发起支付核心。
 *
 * @why 幂等键必带（契约 IdemKey required）：发起支付会调机构建会话，
 *      客户端超时重试没有键就会建出第二个意图（机构侧幂等键是按"我们给的键"去重的，
 *       HTTP 层重试换一个新键 = 新会话）。runInTx 的占位+业务写+结果写回同事务，
 *      与建单（orders.create）同一模式。
 *
 * @why 限流挂 publicWrite（30 次/分钟/IP）：每次发起都可能产生一次出站机构调用，
 *      不限流等于把我们对机构 API 的调用频次交给网络另一端决定。
 *
 * @tradeoff 限流桶是"按规则共享"而不是"按路由独享"：建单等同属 publicWrite 的写接口
 *      会**预消耗**本接口的配额，突发建单后紧跟发起支付可能更早撞 42901。
 *      换来限流规则表只有一份、新增写接口不用单独调额；代价是配额语义不直观
 *      （测试里要绕开就得直接插单，见 pay-intent-routes.db.test.ts 的限流用例）。
 *
 * @see app/pay-intent.ts（核心：守卫/复用/换通道/短链）；contracts/api-contract.yaml
 *      （PaymentIntent）；docs/I1阶段开发实施方案.md §3.6
 */
import type { Express, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { AppConfig } from '../config.js';
import type { PaymentRegistry } from '../ports/payment.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { scopeKey, type IdempotencyExecutor } from '../ports/idempotency.js';
import { createPayIntent } from './pay-intent.js';

export interface PayIntentRoutesDeps {
  logger: Logger;
  clock: Clock;
  idGen: IdGen;
  config: AppConfig;
  auth: AuthConfig;
  identity?: IdentityCheck | undefined;
  idempotency: IdempotencyExecutor<Db>;
  registry: PaymentRegistry;
  /** 限流中间件（装配处按 rateLimitRules.publicWrite 生成后传入）。 */
  payLimiter: RequestHandler;
}

export function mountPayIntentRoutes(app: Express, deps: PayIntentRoutesDeps): void {
  app.post(
    '/api/v1/orders/:id/pay',
    deps.payLimiter,
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);

          const raw = req.params['id'];
          const orderId = typeof raw === 'string' ? raw : '';
          if (orderId.length === 0) throw new AppError(40001, { reason: 'order_id_required' });

          const clientKey = req.header('idempotency-key');
          if (clientKey === undefined || clientKey.trim().length === 0) {
            throw new AppError(40001, { reason: '缺少 Idempotency-Key 头' });
          }

          const body = req.body as Record<string, unknown> | null;
          const channel = body?.['channel'];
          if (typeof channel !== 'string' || channel.length === 0) {
            throw new AppError(40001, { reason: 'channel_required' });
          }

          const result = await deps.idempotency.runInTx(
            {
              key: scopeKey({ userId: sub, route: 'orders.pay', clientKey }),
              userId: sub,
              route: 'orders.pay',
              // N3：指纹素材必传（客户端复用键换通道 → 40908，与建单同口径）
              request: req.body,
              logger: deps.logger,
            },
            async (tx) => {
              const r = await createPayIntent(
                tx,
                {
                  config: deps.config,
                  clock: deps.clock,
                  idGen: deps.idGen,
                  logger: deps.logger,
                  registry: deps.registry,
                },
                { orderId, userId: sub, channel },
              );
              return {
                status: 200,
                body: {
                  channel: r.channel,
                  charge: { currency: r.charge.currency, amount: r.charge.amount },
                  payload: r.payload,
                  expires_at: r.expiresAt.toISOString(),
                },
              };
            },
          );
          res.status(result.status).json(result.body);
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
