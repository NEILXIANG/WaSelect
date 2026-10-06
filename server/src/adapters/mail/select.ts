/**
 * 职责：按配置选 Mailer（剩余清单 2-2）——有密钥用 Resend，没有就只记日志。
 * @why 选择逻辑单独成函数：main.ts 的装配不好测，"配了密钥却还在用 log-only"这种接线错只能在这里被单测抓到。
 * @limitation 只认 Resend 一家（D-41 的 SES 备选未实现）：换 SES 时在这里加一个分支与适配器。
 */
import type { AppConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { HttpClient } from '../../ports/http-client.js';
import type { Mailer } from '../../ports/mailer.js';
import { createLogOnlyMailer } from './log-only.js';
import { createResendMailer } from './resend.js';

export function selectMailer(
  config: Pick<AppConfig, 'MAIL_PROVIDER_API_KEY' | 'MAIL_FROM'>,
  deps: { http: HttpClient; logger: Logger },
): Mailer {
  const key = config.MAIL_PROVIDER_API_KEY;
  const from = config.MAIL_FROM;
  // config 跨字段 6 已保证"有 key 必有 from"；这里两者都判是为了类型收窄，不是另一套口径
  if (key !== undefined && from !== undefined) {
    return createResendMailer({ apiKey: key, from, http: deps.http });
  }
  return createLogOnlyMailer(deps.logger);
}
