/**
 * 职责：**微信登录端口**（I1-U6b）——业务核心认识的"微信登录"只有 code2session
 *      这一件事，不认识 AppID、不认识 secret、不认识微信的错误码表。
 *
 * @why 抽象成端口而不是直接在路由里 fetch：code2session 是一次**出站三方调用**，
 *      它的超时/熔断/日志要走统一出站客户端（ports/http-client.ts），
 *      它的真身（真实微信 API / dev 假登录）要按环境可换——
 *      「依赖要真，只有三方用 Fixture」这条原则在三方 API 上的兑现处。
 *
 * @why 返回值**只有 openid**：微信还回 `session_key`（解密用户敏感数据的钥匙）与
 *      `unionid`（开放平台口径）。session_key 等同"该用户的半个密码"——
 *      MVP 没有要解密的用户数据，让它出适配器只会增加落日志/落库的风险面；
 *      哪天真需要（I2 手机号授权），在端口上加**具名方法**（decryptPhone 之类），
 *      而不是把 session_key 放进返回值让全链路都可能碰到它。
 *
 * @limitation 错误语义只分两档，不细分微信 errcode：
 *      - code 无效/已被使用（用户侧问题：重放、过期、伪造）→ **40101**（与契约 401 对齐）；
 *      - 其余一切（我们配错密钥 / 微信故障 / 频率限制）→ 抛普通 Error 折叠 **50000**。
 *      细分 errcode 表会随微信文档漂移，且"我们的配置错误"不该伪装成"用户的登录失败"。
 *
 * @see adapters/wechat/code2session.ts（真实实现）；adapters/wechat/dev-auth.ts（dev 实现）
 */
export interface WechatSession {
  /** 微信侧用户唯一标识（小程序主体口径）。**禁止明文进日志**（ADR-29 脱敏红线）。 */
  openid: string;
}

export interface WechatAuth {
  /**
   * wx.login 的 code 换 openid。
   * @throws {AppError} 40101（code 无效/已用——用户侧问题）
   * @throws {Error} 其它失败（配置/上游——折叠 50000）
   */
  code2session(code: string): Promise<WechatSession>;
}
