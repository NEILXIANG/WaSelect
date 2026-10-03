/**
 * 职责：**dev 微信登录**适配器（I1-U6b）——AppID 未下来前的本机/CI 联调替身。
 *
 * ⚠️ **它等价于无密码登录**：不校验 code，openid = `${prefix}${code}`——
 *    任何人用任意 code 字符串都能登进对应账号。它只能活在 development/test：
 *    生产与 staging 由 loadConfig 交叉校验拒启（config.ts 规则 1c），
 *    装配层另有一层环境判定（mount.ts）——两道防线：配置层拒启 + 装配层不注册。
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

/** `users.openid` 的列宽（migrations/001：VARCHAR(64)）。 */
const OPENID_MAX_LENGTH = 64;

/**
 * @why 替身**自己**守住列宽（AJ-316）：`openid = 前缀 + code`，而前缀是运营可配的任意串
 *      （`WECHAT_DEV_LOGIN`），所以路由侧那个 128 的 code 上限**保证不了**拼出来 ≤64。
 *      不判的话超长会撞 PG 的 22001 → 兜底折成泛化的 40001「参数缺失或格式错误」——
 *      提示指向错误的字段，而这条链路的输入只有 code 一个，联调的人会去查微信而不是查前缀。
 * @limitation 这是 **dev/test 专用**路径（生产与 staging 由 loadConfig 规则 1c 拒启），
 *      所以选择"响亮报错"而不是截断——截断会让两个不同 code 撞成同一个 openid，
 *      那比报错危险得多（一个人登进另一个人的账号）。
 */
export function createDevWechatAuth(prefix: string): WechatAuth {
  return {
    code2session(code: string): Promise<WechatSession> {
      const openid = `${prefix}${code}`;
      if (openid.length > OPENID_MAX_LENGTH) {
        throw new Error(
          `dev 登录：前缀 ${String(prefix.length)} + code ${String(code.length)} = ` +
            `${String(openid.length)} 字符，超过 users.openid 列宽 ${String(OPENID_MAX_LENGTH)}` +
            `（缩短 WECHAT_DEV_LOGIN 前缀或换一个短 code）`,
        );
      }
      return Promise.resolve({ openid });
    },
  };
}
