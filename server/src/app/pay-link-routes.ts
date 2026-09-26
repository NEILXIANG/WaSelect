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
 * @why 失效页用**相对路径** `/pay/expired`：302 的 Location 允许相对引用，
 *      浏览器相对当前 host（checkout 静态站）解析。换来零配置依赖——
 *      本路由不需要 CHECKOUT_BASE_URL（它只管"跳到我们自己站的哪个页面"，
 *      这个答案不该依赖配置）；代价是 `res.redirect` 的相对跳转依赖
 *      客户端按 RFC 7231 解析（浏览器/fetch 均如此，curl 也跟随）。
 *
 * @tradeoff 限流挂 publicWrite 共享桶（规则表注释早已把"短链"列进这条规则）：
 *      与建单/报价/发起支付同桶，意味着短链点击会被其它写路径预消耗、
 *      也会反过来消耗它们——换来限流规则只有一份表；30 次/分钟/IP 对
 *      "一个人点几次链接"足够，对"枚举 token"则远远不够（2^128 分之 30）。
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

/** 失效页（checkout 静态站内的相对路径，见文件头 @why）。 */
export const PAY_LINK_EXPIRED_PATH = '/pay/expired';

export interface PayLinkRoutesDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
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
        res.redirect(302, outcome.type === 'redirect' ? outcome.url : PAY_LINK_EXPIRED_PATH);
      } catch (e) {
        next(e);
      }
    })();
  });
}
