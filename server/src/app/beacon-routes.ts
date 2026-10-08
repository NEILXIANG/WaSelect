/**
 * 职责：`POST /api/v1/beacon`——小程序用户行为批量上报（流 C，ADR-29；M-21 / AJ-409）。
 *      校验（domain/beacon-input.ts）→ 可选身份 → id 存在性核对 → 一条 INSERT 落 `user_events` → 204。
 *
 * @why **鉴权可选**：已登录买家的 token 有效就记 `user_id`；没有 / 无效 / 被封禁 / 版本失效 → **降级匿名**，
 *      **不回 401**。401 会触发小程序请求层"静默重登并重放"，埋点不能引起任何用户可见的副作用；
 *      而且匿名浏览本来就是漏斗的前半段（首页、详情不需要登录）。
 * @why 匿名 id（`anon_id`，客户端生成、本地存储的 `an-` + 20 位 Base32）**每条都存**进 `session_id`，
 *      登录与否都存：登录前后的事件靠它连成一条漏斗。它是随机串、不含设备信息，清本地存储即换新。
 * @why id 必须**真实存在**才落库（形状之外的第二层 PII 防线）：形状挡不住纯字母数字的 PII
 *      （去掉 `+` 的电话号码、openid 本身就是 base64url）——查一次 products / orders，
 *      不存在的那条**丢弃**、同批其余照收，warn 只记条数（不记值：值可能正是 PII）。
 *      丢弃而不整批拒：商品被删、订单 id 来自旧缓存是正常情形，整批拒会连带丢掉同批的合法事件。
 * @why `trace_id` / `req_id` 取本次请求的上下文：小程序发 beacon 时带自己的 `x-trace-id`，
 *      与该用户同一时刻的业务请求是并列的链；事件与业务日志的关联键是 order_id / product_id。
 * @limitation 一：订单存在性**不看归属**（不比对 user_id）：有人往别人的订单 id 上记 pay_abandon，
 *              只会污染统计，不泄露任何东西（响应恒为 204，没有存在性神谕）；按归属过滤还会把
 *              "token 刚过期、降级匿名"的那批支付事件全部丢掉。
 * @limitation 二：限流沿用公开写入口规则（每 IP 每分钟 RATE_LIMIT_QUOTE_PER_MIN，独立桶 `public.write.beacon`）；
 *              CGNAT 下多人共享出口 IP 会被一起限——埋点本就有损，被限的批次客户端直接丢弃，不重试。
 * @limitation 三：先 await 落库再回 204（不 fire-and-forget）：一条 INSERT + 至多两次主键查询，耗时与普通请求同级；
 *              换来"204 = 已落库"这条可断言的语义，失败走 50000 进 error 日志（客户端照样丢弃）。
 * @see domain/beacon-input.ts；adapters/user-events.ts；contracts/api-contract.yaml `/beacon`
 */
import type { Express, Request } from 'express';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { createUserEventsRepo } from '../adapters/user-events.js';
import { currentContext, patchContext } from '../context.js';
import { parseBeaconBatch } from '../domain/beacon-input.js';
import { bearerOf, verifyToken, type AuthConfig } from './auth.js';

export interface BeaconRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  /** 身份回源（D25）：封禁 / 版本失效的 token 不记 user_id。 */
  identity: IdentityCheck;
}

/** 有效买家 → sub；其余一律 null（不抛 40101，见文件头）。基础设施异常照常抛出（走 50000）。 */
async function optionalBuyerId(
  req: Request,
  cfg: AuthConfig,
  identity: IdentityCheck,
): Promise<string | null> {
  const token = bearerOf(req);
  if (token === undefined) return null;
  const principal = await verifyToken(token, cfg, 'user').catch(() => null);
  if (principal === null || principal.role !== 'user') return null;
  const rec = await identity.load(principal.sub);
  if (rec === null || rec.blockedAt !== null || rec.tokenVer !== (principal.ver ?? 1)) return null;
  return principal.sub;
}

export function mountBeaconRoutes(app: Express, deps: BeaconRoutesDeps): void {
  const repo = createUserEventsRepo(deps.db);
  app.post('/api/v1/beacon', (req, res, next) => {
    void (async () => {
      try {
        const batch = parseBeaconBatch(req.body);
        const userId = await optionalBuyerId(req, deps.auth, deps.identity);
        if (userId !== null) patchContext({ user_id: userId });

        const pick = (k: string) =>
          batch.events.flatMap((e) => (typeof e.props[k] === 'string' ? [e.props[k]] : []));
        const [products, orders] = await Promise.all([
          repo.existingProductIds(pick('product_id')),
          repo.existingOrderIds(pick('order_id')),
        ]);
        const kept = batch.events.filter((e) => {
          const p = e.props.product_id;
          const o = e.props.order_id;
          return (
            (typeof p !== 'string' || products.has(p)) && (typeof o !== 'string' || orders.has(o))
          );
        });
        const dropped = batch.events.length - kept.length;
        if (dropped > 0) {
          deps.logger.warn('beacon_events_dropped', {
            result: 'skipped',
            ctx: { reason: 'unknown_id', dropped, received: batch.events.length },
          });
        }
        const { trace_id: traceId, req_id: reqId } = currentContext();
        await repo.append(
          { userId, sessionId: batch.anonId, traceId: traceId ?? null, reqId: reqId ?? null },
          kept.map((e) => ({ event: e.name, props: e.props })),
        );
        res.status(204).end();
      } catch (e) {
        next(e);
      }
    })();
  });
}
