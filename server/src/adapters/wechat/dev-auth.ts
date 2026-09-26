/**
 * 职责：**dev 微信登录**适配器（I1-U6b）——AppID 未下来前的本机/CI 联调替身。
 *
 * ⚠️ **它等价于无密码登录**：不校验 code，openid = `${prefix}${code}`——
 *    任何人用任意 code 字符串都能登进对应账号。它只能活在 development/test：
 *    生产与 staging 由 loadConfig 交叉校验拒启（config.ts 规则 1c），
 *    装配层另有一层环境判定（mount.ts）——两道，与 skeleton 的 SEC2 同精神。
 *
 * @why 要这个替身而不是"等 AppID 下来再开发"：登录是小程序链路的第一个接口，
 *      商品/地址/建单全部依赖它签发的 token；等境外主体 AppID（公司登记后数周）
 *      才能跑通登录 = I1 全部用户链路无法端到端验证。
 * @why openid 带**前缀**而不是裸 code：dev 用户与真实微信用户在 users 表同一条
 *      唯一索引上，前缀（如 `dev-`）让两个世界永远撞不到一起——
 *      真实 openid 是 28 位随机串，不会以 `dev-` 开头。
 *
 * @limitation 不模拟微信的错误路径（无效 code / 频率限制）：那些行为在
 *      code2session.ts 的单测里钉；dev 替身只负责"让登录链路在没有微信时可走通"。
 *
 * @see ports/wechat-auth.ts；config.ts WECHAT_DEV_LOGIN（开关与生产/staging 禁令）
 */
import type { WechatAuth, WechatSession } from '../../ports/wechat-auth.js';

export function createDevWechatAuth(prefix: string): WechatAuth {
  return {
    code2session(code: string): Promise<WechatSession> {
      return Promise.resolve({ openid: `${prefix}${code}` });
    },
  };
}
