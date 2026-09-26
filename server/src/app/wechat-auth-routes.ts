/**
 * 职责：`POST /auth/wechat/login` 路由薄壳（I1-U6b）——HTTP 形状校验 + 调登录核心。
 *
 * @why 无鉴权（契约 security:[]）——它就是来**发**身份的入口；wx.login 的 code
 *      只能由装了微信且打开了我们小程序的客户端拿到，code 一次性、有效期 5 分钟，
 *      暴力枚举的收益是"登进一个刚建的空账号"，仍按契约挂 IP 限流（429）。
 *
 * @why 未配置也**挂路由**（调用时 50000 wechat_login_not_configured），而不是
 *      不挂让 404——404 会把"我们没配 AppID"表现成"前端打错了地址"，
 *      排查方向整个反掉；响亮失败的 50000 才是"这是我们的配置缺口"的诚实表达
 *      （NOT_IMPLEMENTED 清单已删此路径，路由必须在）。
 *
 * @tradeoff 限流挂 publicWrite 共享桶（规则表注释早已把"小程序登录"列进这条规则）：
 *      与建单/报价/短链同桶，突发建单后登录可能更早撞 42901；
 *      换来限流规则只有一份表——登录是每分钟 30 次/IP 远远够用的低频动作。
 *
 * @see app/wechat-login.ts（核心）；ports/wechat-auth.ts；contracts/api-contract.yaml
 *      /auth/wechat/login
 */
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { IdGen } from '../ports/ids.js';
import type { WechatAuth } from '../ports/wechat-auth.js';
import type { AuthConfig } from './auth.js';
import { loginWithWechat } from './wechat-login.js';

const bodySchema = z.object({ code: z.string().min(1) }).strict();

export interface WechatAuthRoutesDeps {
  db: Db;
  logger: Logger;
  idGen: IdGen;
  authConfig: AuthConfig;
  /** null = 未配置（既无真 AppID 也未开 dev 登录）→ 50000（文件头 @why）。 */
  wechatAuth: WechatAuth | null;
  /** 限流中间件（装配处按 rateLimitRules.publicWrite 生成后传入）。 */
  loginLimiter: RequestHandler;
}

export function mountWechatAuthRoutes(app: Express, deps: WechatAuthRoutesDeps): void {
  app.post('/api/v1/auth/wechat/login', deps.loginLimiter, (req, res, next) => {
    void (async () => {
      try {
        if (deps.wechatAuth === null) {
          throw new AppError(50000, { reason: 'wechat_login_not_configured' });
        }
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) throw new AppError(40001, { reason: 'code 必填（非空字符串）' });

        const r = await loginWithWechat(
          deps.db,
          {
            wechatAuth: deps.wechatAuth,
            authConfig: deps.authConfig,
            idGen: deps.idGen,
            logger: deps.logger,
          },
          { code: parsed.data.code },
        );
        res.status(200).json({ token: r.token, user: r.user });
      } catch (e) {
        next(e);
      }
    })();
  });
}
