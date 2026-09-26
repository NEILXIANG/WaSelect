/**
 * 职责：**真实微信登录**适配器（I1-U6b）——`jscode2session` 的 HTTP 封装。
 *
 * @why 出站一律走注入的 `HttpClient`（统一超时/总预算/熔断/`http_outbound` 日志）：
 *      微信 API 也会挂、也会慢；登录链路没有熔断保护时，微信侧抖动会把我们的
 *      登录接口拖到全面超时。secret 放在 query 里（微信只支持这种形态），
 *      出站日志由 fetch-client 的 `safeUrl` 统一去查询串——**本文件不自己拼日志**。
 *
 * @why 微信的错误是 **HTTP 200 + errcode 非 0**——这是它和"正常 REST"最大的不同：
 *      只检查 status 会把 `{"errcode":40029}` 当成成功，于是"code 无效"被当成
 *      "登录成功但拿不到 openid"，排查方向整个反掉。所以本适配器的解析顺序是
 *      先 errcode、后 openid，两条路互斥。
 *
 * @limitation 一：错误映射只认两个 code（40029 invalid code / 40163 code been used）——
 *              它们是"用户侧问题"（重放/过期/伪造），映射 40101；
 *              其余（-1 系统繁忙 / 45011 频率限制 / 40125 secret 错…）一律抛 Error
 *              折叠 50000：**我们的配置错误绝不能伪装成用户的登录失败**。
 *              细分 errcode 表会随微信文档漂移（NEEDS VERIFICATION：以官方文档为准，
 *              未做真机实测——公司主体 AppID 未下来，当前只按文档口径实现）。
 * @limitation 二：不做 code 级幂等缓存——微信 code 本身就是一次性的
 *              （重放 = 40163 = 40101），客户端重试会换新 code，缓存没有命中场景。
 *
 * @see ports/wechat-auth.ts（错误语义两档的定义处）；https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 */
import { AppError } from '../../errors.js';
import type { HttpClient } from '../../ports/http-client.js';
import type { WechatAuth, WechatSession } from '../../ports/wechat-auth.js';

const API_URL = 'https://api.weixin.qq.com/sns/jscode2session';

/** 微信侧"用户自己的问题"的 errcode：重放/过期/伪造的 code 都落在这里（→ 40101）。 */
const USER_FAULT_ERRCODES: ReadonlySet<number> = new Set([40_029, 40_163]);

export interface WechatAuthOptions {
  http: HttpClient;
  appId: string;
  appSecret: string;
}

export function createWechatAuth(opts: WechatAuthOptions): WechatAuth {
  return {
    async code2session(code: string): Promise<WechatSession> {
      const query = new URLSearchParams({
        appid: opts.appId,
        secret: opts.appSecret,
        js_code: code,
        grant_type: 'authorization_code',
      });
      const res = await opts.http.send({ method: 'GET', url: `${API_URL}?${query}` });
      if (res.status !== 200) {
        // 微信自身故障/反爬拦截：不是用户的问题，折叠 50000
        throw new Error(`wechat code2session HTTP ${res.status}（openid 未取得）`);
      }
      const json = JSON.parse(res.body) as {
        openid?: string;
        session_key?: string;
        errcode?: number;
        errmsg?: string;
      };
      // ⚠️ 先 errcode 后 openid（文件头 @why）：200 + errcode 才是微信错误的主形态
      if (typeof json.errcode === 'number' && json.errcode !== 0) {
        if (USER_FAULT_ERRCODES.has(json.errcode)) {
          // errmsg 进 ctx 供排查（微信原文，无 PII）；对外统一 40101 不细分
          throw new AppError(40101, { reason: 'wechat_code_rejected', errcode: json.errcode });
        }
        throw new Error(`wechat code2session errcode=${json.errcode} ${json.errmsg ?? ''}`);
      }
      if (typeof json.openid !== 'string' || json.openid.length === 0) {
        // 无 errcode 又无 openid：微信回包形状变了——响亮失败而不是默默登录失败
        throw new Error('wechat code2session 响应缺 openid（回包形状漂移？）');
      }
      // ⚠️ session_key 到此处为止（端口 @why）：不放进返回值、不进日志、不落库
      return { openid: json.openid };
    },
  };
}
