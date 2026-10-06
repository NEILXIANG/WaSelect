/**
 * 职责：Resend 邮件适配器（剩余清单 2-2 / D-41）。手写一个 POST，不引入官方 SDK（完全自研，见 CLAUDE.md）。
 *
 * @measured(resend.com/docs/api-reference/emails/send-email, 2026-10-06)：
 *   `POST https://api.resend.com/emails`；鉴权 `Authorization: Bearer re_xxxxxxxxx`；
 *   必填 `from`（支持 "Name <email@example.com>"）、`to`（string | string[]，最多 50）、`subject`，`text` 或 `html` 二选一；
 *   幂等头 `Idempotency-Key`：每个请求唯一、24 小时过期、最长 256 字符；成功响应 JSON 带 `id`。
 *   ⚠️ 文档摘录未列出限流与错误码形态——本实现只按"2xx 且有 id"判成功，其余一律抛错。
 * @why 走注入的 `HttpClient`（与 Stripe 同一份出站客户端）：超时、重试判定、熔断、出站日志都复用，
 *      不在这里再造一套。带幂等键的 POST 在客户端层可被安全重试。
 * @why `to` 发数组：文档两种形态都收，数组形态将来加抄送不改协议。
 * @limitation 只发纯文本（端口 @limitation 一）；不处理退信 / 投诉回调（需要 webhook，MVP 不做）。
 * @tradeoff 错误消息只带状态码与响应体前 200 字：响应体可能回显字段名，但不会回显我们没发过去的东西；
 *           收件人地址**不进**错误消息（错误会被订阅者写进日志）。
 */
import type { HttpClient } from '../../ports/http-client.js';
import type { MailMessage, MailResult, Mailer } from '../../ports/mailer.js';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** @measured 见文件头：Resend 幂等键上限 256 字符。 */
const IDEMPOTENCY_KEY_MAX = 256;

export interface ResendOptions {
  apiKey: string;
  /** 发件人（"Name <addr>" 形态）；域名须在 Resend 后台验证过。 */
  from: string;
  http: HttpClient;
}

export function createResendMailer(opts: ResendOptions): Mailer {
  return {
    async send(msg: MailMessage): Promise<MailResult> {
      // 超长键会被服务商拒；在发送前拦下，错误更早、更清楚
      if (msg.idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
        throw new Error(`邮件幂等键超过 ${String(IDEMPOTENCY_KEY_MAX)} 字符（tag=${msg.tag}）`);
      }
      const res = await opts.http.send({
        method: 'POST',
        url: RESEND_ENDPOINT,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': msg.idempotencyKey,
        },
        body: JSON.stringify({
          from: opts.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
        }),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `resend 发送失败：HTTP ${String(res.status)} ${res.body.slice(0, 200)}（tag=${msg.tag}）`,
        );
      }
      const json = JSON.parse(res.body) as { id?: unknown };
      if (typeof json.id !== 'string') throw new Error(`resend 响应缺 id（tag=${msg.tag}）`);
      return { status: 'sent', id: json.id };
    },
  };
}
