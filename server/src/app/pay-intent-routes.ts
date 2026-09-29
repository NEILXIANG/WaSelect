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
 * @tradeoff 限流桶按入口独享（全量审计 2026-09-26 起）：建单、报价、发起支付各自 30 次/分钟/IP，
 *      互不预消耗；限流规则表仍只有一份（`publicWrite(routeKey)`），新增写接口只需给一个 routeKey。
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
import {
  createPayIntent,
  redactPayToken,
  reissuePayLinkOnReplay,
  type PayIntentResult,
} from './pay-intent.js';
import type { AutoConfirm } from './auto-confirm.js';

export interface PayIntentRoutesDeps {
  /** 幂等重放时补发短链要开自己的事务（KD-3：重放体里的明文 token 已被抹掉）。 */
  db: Db;
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
  /**
   * 事务提交后的审核模式自动确认（技术文档 §2.9 / AJ-179）；缺省 = 不做。
   * 是否真的确认由通道能力决定（app/auto-confirm.ts），路由不认识任何通道。
   */
  autoConfirm?: AutoConfirm | undefined;
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

          /** 本次**新执行**（非幂等重放）的意图：提交后交给自动确认。 */
          let committed: PayIntentResult | undefined;
          const result = await deps.idempotency.runInTx(
            {
              key: scopeKey({ userId: sub, route: 'orders.pay', clientKey }),
              userId: sub,
              route: 'orders.pay',
              // N3：指纹素材必传（客户端复用键换通道 → 40908，与建单同口径）
              // 🔴 **必须含路径里的 orderId**：作用域只按「用户 + 路由 + 客户端键」拼
              //    （`scopeKey`），orderId 不在键里。它若不进指纹，同一把键用在另一张单上
              //    就是"同键同参"→ 命中上一张单的幂等行并重放它的响应：
              //    copylink 拼成「上一张单的金额 + 这一张单的短链」，in_app 直接把上一张单的
              //    会话交给正在付这一单的人（钱进了 A 的会话，用户以为在付 B）。
              //    小程序历史上每次点击都现造键 ⇒ 当年不可达；A5 改成键复用之后变为可达。
              //    @see AJ-195；app/pay-intent.ts 的 reissuePayLinkOnReplay（它的安全性依赖这里）
              request: { order_id: orderId, ...(body ?? {}) },
              logger: deps.logger,
              // KD-3（AJ-175）：短链明文 token 不许随响应体进幂等表——落库前抹掉，重放时补发
              persist: redactPayToken,
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
              committed = r;
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
          // 审核模式：提交之后才确认（管线要读到已提交的 payments 行，auto-confirm.ts @why）。
          // ⚠️ 必须在回响应之前等它完成：小程序见 auto=true 立刻显示「支付已完成」并去看订单
          if (!result.replayed && committed !== undefined && deps.autoConfirm !== undefined) {
            await deps.autoConfirm({
              orderId,
              channel: committed.channel,
              providerRef: committed.providerRef,
              charge: committed.charge,
            });
          }
          const out = result.replayed
            ? await reissuePayLinkOnReplay(
                deps.db,
                {
                  config: deps.config,
                  clock: deps.clock,
                  idGen: deps.idGen,
                  logger: deps.logger,
                  registry: deps.registry,
                },
                { orderId, userId: sub },
                result.body,
              )
            : result.body;
          res.status(result.status).json(out);
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
