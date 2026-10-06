/**
 * 职责：未配置邮件服务商时的 Mailer——只记一条 `mail_skipped` 日志（剩余清单 2-2）。
 *
 * @why 开发、测试与审核期没有 Resend 账号也要能跑通"下单 → 发货 → 退款"的通知链路；
 *      记日志而不是静默：运营能从日志看出"这里本该发一封信"，上线前忘了配密钥也看得见。
 * @limitation 日志只有 tag，不含收件人与正文（约束七：邮箱是 PII）。
 */
import type { Logger } from '../../logger.js';
import type { MailMessage, MailResult, Mailer } from '../../ports/mailer.js';

export function createLogOnlyMailer(logger: Logger): Mailer {
  return {
    send(msg: MailMessage): Promise<MailResult> {
      logger.info('mail_skipped', {
        result: 'skipped',
        ctx: { tag: msg.tag, reason: 'no_provider' },
      });
      return Promise.resolve({ status: 'skipped', reason: 'no_provider' });
    },
  };
}
