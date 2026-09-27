/**
 * 职责：`GET /pay/link/{id}` 路由薄壳（I1-U6a-2 / D-49）——短链落地，302 搬运工。
 *
 * @why **无鉴权**（契约 security:[]）：链接通过微信聊天/短信复制传播，
 *      打开它的浏览器没有我们的 JWT——链接里的 token 本身就是凭证（bearer）。
 *      安全性因此全部押在：128 bit 熵 + sha256 落库（库泄露不泄链接）+
 *      复用即轮换（同时只有一条活链接）+ IP 限流（挡暴力枚举）。
 *
 * @why 失败也 **302 到失效页**而不是 4xx JSON：这个端点的"客户端"是浏览器地址栏，
 *      用户是点了链接的人，不是调 API 的程序——给他看 JSON 错误没有意义，
 *      失效页（checkout-static/pay/expired）才有「请回微信重新发起支付」的引导。
 *
 * @why 失效页必须是**绝对地址**（全量审计 2026-09-26 P1）：真实链路是静态站 `/o/:id` 先 302 到
 *      **API 域名**的本路由，此时相对 `/pay/expired` 会按 API 主机解析（RFC 7231），API 上没有该页 →
 *      用户看到 JSON 40400。曾经的"相对路径、零配置依赖"前提不成立：本路由必须知道静态站在哪
 *      （`CHECKOUT_BASE_URL`，stripe 启用时生产已必填；未配置时退化为相对路径，仅本地开发）。
 *
 * @tradeoff 限流挂 publicWrite（按入口独立桶，全量审计 2026-09-26 起不再共享）：
 *      30 次/分钟/IP 对"一个人点几次链接"足够，对"枚举 token"则远远不够（2^128 分之 30），
 *      枚举防线是 token 熵，不是限流。
 *
 * @limitation 不记录 query：token 在 `?t=` 里，全局访问日志只记 `req.path`
 *      （http.ts 访问日志的既定字段），本路由自己也不读 `req.url`——
 *      「链接即钥匙」的钥匙不能进任何日志流（ADR-29 红线）。
 *
 * @see app/pay-link.ts（全部判定逻辑）；contracts/api-contract.yaml /pay/link/{id}
 */
import type { Express, RequestHandler } from 'express';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../logger.js';
import { resolvePayLink } from './pay-link.js';

/** 短链路径前缀（checkout-static/_redirects 把 /o/* 302 到这里）。 */
export const PAY_LINK_PREFIX = '/api/v1/pay/link';

/**
 * 失效页路径（checkout 静态站上的页面，scripts/checkout-build-lib.ts CHECKOUT_PAGES 之一）。
 * ⚠️ 必须拼成**绝对地址**再 302（全量审计 2026-09-26 P1）：到达本路由时浏览器已经在 API 域名上
 *    （静态站 `/o/*` 先 302 到这里），相对 `/pay/expired` 会按当前主机解析成 `https://api…/pay/expired`——
 *    API 上没有这个路由，用户看到的是 JSON 40400 而不是引导页。
 */
export const PAY_LINK_EXPIRED_PATH = '/pay/expired';

export interface PayLinkRoutesDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /**
   * checkout 静态站根地址（config.CHECKOUT_BASE_URL；stripe 启用时生产必填）。
   * 未配置（本地开发）时退化为相对路径——此时链路本来就不经过静态站。
   */
  checkoutBaseUrl: string | undefined;
  /** 限流中间件（装配处按 rateLimitRules.publicWrite 生成后传入）。 */
  linkLimiter: RequestHandler;
}

export function mountPayLinkRoutes(app: Express, deps: PayLinkRoutesDeps): void {
  app.get(`${PAY_LINK_PREFIX}/:id`, deps.linkLimiter, (req, res, next) => {
    void (async () => {
      try {
        const raw = req.params['id'];
        const orderId = typeof raw === 'string' ? raw : '';
        // t 缺失/非串 → 与 token 错误同处置（302 失效页）：不教探测者"参数形状"
        const tq = req.query['t'];
        const token = typeof tq === 'string' ? tq : '';

        const outcome = await resolvePayLink(
          deps.db,
          { clock: deps.clock, logger: deps.logger },
          { orderId, token },
        );
        res.redirect(
          302,
          outcome.type === 'redirect' ? outcome.url : expiredPageUrl(deps.checkoutBaseUrl),
        );
      } catch (e) {
        next(e);
      }
    })();
  });
}

/** 失效页绝对地址；去掉 base 尾部斜杠避免 `//pay/expired`。 */
export function expiredPageUrl(checkoutBaseUrl: string | undefined): string {
  if (checkoutBaseUrl === undefined || checkoutBaseUrl === '') return PAY_LINK_EXPIRED_PATH;
  return `${checkoutBaseUrl.replace(/\/+$/, '')}${PAY_LINK_EXPIRED_PATH}`;
}
