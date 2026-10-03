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
 * @tradeoff 限流挂 publicWrite（按入口独立桶，全量审计 2026-09-26 起不再共享）：
 *      登录桶不再被建单/报价/短链预消耗；30 次/分钟/IP 对登录这种低频动作远远够用。
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

/**
 * `code` 的**长度上限**（AJ-316，第二轮审查 DB2-08）。
 *
 * @why 这是**无鉴权**入口：`code` 是客户端唯一可控的输入，而它会被原样拼进发往
 *      `api.weixin.qq.com` 的查询串（`code2session.ts`），dev 替身下还直接参与
 *      `openid = 前缀 + code` 的计算。没有上限时，客户端可以送接近 JSON body 上限长度的
 *      字符串，而我们**在入口什么都不判**。
 * @why 取 **128** 而不是"按列宽推"：真实的 `js_code` 约 32 字符，128 是 4 倍余量，
 *      不会误伤；而它要挡的是"送一个 10KB 字符串"这种量级的输入，不是卡边界。
 *      ⚠️ 因此它**不保证** dev 替身下 `前缀 + code` 不超过 `users.openid` 的 VARCHAR(64)
 *      ——那是 `WECHAT_DEV_LOGIN` 前缀自己的长度问题（前缀是运营可配的任意串），
 *      且只存在于 development/test（生产与 staging 由 loadConfig 规则 1c 拒启）。
 * @limitation 真微信 code 的长度**未见官方声明**（docs 无表述，未做真机实测）——
 *              所以 128 是"宽松到不会误伤"的取值，不是"按文档卡死"的取值。
 *              若将来拿到官方上限，应改这里并同步契约 `maxLength`。
 *
 * @see adapters/wechat/code2session.ts（查询串拼接处）；contracts/api-contract.yaml（code）
 */
const WECHAT_CODE_MAX_LENGTH = 128;

const bodySchema = z.object({ code: z.string().min(1).max(WECHAT_CODE_MAX_LENGTH) }).strict();

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
        // 文案带上区间（AJ-316）：只说"必填"的话，填了超长的人不知道是被长度拒的
        if (!parsed.success) {
          throw new AppError(40001, {
            reason: `code 必填（1–${String(WECHAT_CODE_MAX_LENGTH)} 字符）`,
          });
        }

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
