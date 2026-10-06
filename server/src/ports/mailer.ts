/**
 * 职责：邮件发送端口（剩余清单 2-2 / D-41：邮件兜底通知，Resend / SES 任选）。
 *
 * @why 用端口而不是在订阅者里直接调 Resend：D-41 定的是"Resend 或 SES"，服务商可换；
 *      端口把"发一封信"与"找谁发"分开，换服务商只换适配器。未配密钥时由"只记日志"实现顶上，
 *      开发与审核期不需要任何外部账号。
 * @limitation 一：只有纯文本，没有 HTML 模板（MVP 三类通知都是短句 + 单号 + 链接，纯文本足够且不会被渲染差异坑）。
 * @limitation 二：发送失败不重试、不入队（D-41 写了"队列重试"，MVP 不做）：失败只记 error 日志，
 *              由订阅者的调用方决定是否补发。邮件是**兜底**通道，丢一封不影响订单与钱。
 * @see adapters/mail/resend.ts；adapters/mail/log-only.ts；app/order-mail.ts
 */

export interface MailMessage {
  /** 收件人。⚠️ PII：适配器与调用方都**不得**把它写进日志（约束七脱敏红线）。 */
  to: string;
  subject: string;
  text: string;
  /**
   * 服务商侧幂等键：同一事件重放（进程重启、订阅者重入）不发第二封。
   * 形如 `order.shipped:<orderId>`。
   */
  idempotencyKey: string;
  /** 检索用标签（进日志）：`order.shipped` 等。 */
  tag: string;
}

export type MailResult =
  /** 已交给服务商（id = 服务商的邮件 id）。 */
  | { status: 'sent'; id: string }
  /** 没有配置服务商，只记了日志（开发 / 审核期）。 */
  | { status: 'skipped'; reason: string };

export interface Mailer {
  /** 失败抛错（调用方记 error 日志）；不重试（@limitation 二）。 */
  send(msg: MailMessage): Promise<MailResult>;
}
