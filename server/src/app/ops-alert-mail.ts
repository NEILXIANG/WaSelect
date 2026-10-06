/**
 * 职责：每日对账发现异常时给运营发一封告警邮件（剩余清单 2-4）。
 *
 * @why 对账结果此前只在日志里（error 级）：没人每天去翻日志，异常就等于没报。
 *      邮件是运营一定会看的通道；配了 SENTRY_DSN 时 error 日志另会进 Sentry（2-3），两条互为备份。
 * @why 订阅事件而不是在 job 里直接发：job 在事务里跑，事件在提交后分发——job 回滚就不该发告警。
 * @why 幂等键按**日期**：同一天对账被手动重跑多次（`POST /internal/jobs/daily`）只发一封。
 * @limitation 一：正文只有各类计数，没有订单 id（取样 id 在日志里）：邮件可能被转发，订单 id 不出邮箱更稳妥。
 * @limitation 二：同一天第二次重跑若发现了**新的**异常，因幂等键相同不会再发——要看最新结果去日志。
 * @limitation 三：收件人只有一个（`ALERT_EMAIL`）；多人请用邮件组。
 * @see app/daily-reconciliation.ts（事件来源）；ports/mailer.ts
 */
import type { Logger } from '../logger.js';
import type { EventBus } from '../ports/events.js';
import type { Mailer } from '../ports/mailer.js';

export const RECONCILIATION_ALERT_EVENT = 'reconciliation.anomalies_found';

export interface OpsAlertMailDeps {
  mailer: Mailer;
  logger: Logger;
  /** 收件人（config.ALERT_EMAIL）；undefined = 不发，只记日志。 */
  to: string | undefined;
}

export function registerOpsAlertMail(bus: EventBus, deps: OpsAlertMailDeps): void {
  bus.subscribe(RECONCILIATION_ALERT_EVENT, async (event) => {
    const counts = Object.entries(event.payload ?? {}).filter(
      (e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0,
    );
    const day = event.at.slice(0, 10);
    if (deps.to === undefined) {
      deps.logger.info('ops_alert_skipped', {
        result: 'skipped',
        ctx: { reason: 'no_alert_email', day },
      });
      return;
    }
    try {
      await deps.mailer.send({
        to: deps.to,
        subject: `[Waselect] ${day} 对账发现 ${String(counts.length)} 类异常`,
        text:
          `每日对账（${event.at}）发现以下异常，需要人工处理：\n\n` +
          counts.map(([k, n]) => `${k}: ${String(n)}`).join('\n') +
          `\n\n取样订单 / 回调 id 见日志事件 reconciliation_anomaly。`,
        idempotencyKey: `reconciliation:${day}`,
        tag: RECONCILIATION_ALERT_EVENT,
      });
      deps.logger.info('ops_alert_sent', { result: 'ok', ctx: { day, classes: counts.length } });
    } catch (e) {
      deps.logger.error('ops_alert_failed', {
        result: 'failed',
        ctx: { day, error: e instanceof Error ? e.message : String(e) },
      });
    }
  });
}
