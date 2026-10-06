/**
 * 职责：每日对账发现异常时给运营发一封告警邮件（剩余清单 2-4）。
 *
 * @why 对账结果此前只在日志里（error 级）：没人每天去翻日志，异常就等于没报。
 *      邮件是运营一定会看的通道；配了 SENTRY_DSN 时 error 日志另会进 Sentry（2-3），两条互为备份。
 * @why 订阅事件而不是在 job 里直接发：job 在事务里跑，事件在提交后分发——job 回滚就不该发告警。
 * @why 幂等键按**日期 + 计数摘要**：同一天重跑且结论没变只发一封；结论变了再发一封（扫描 S-04）。
 * @limitation 一：正文只有各类计数，没有订单 id（取样 id 在日志里）：邮件可能被转发，订单 id 不出邮箱更稳妥。
 * @limitation 二：收件人只有一个（`ALERT_EMAIL`）；多人请用邮件组。
 * @see app/daily-reconciliation.ts（事件来源）；ports/mailer.ts
 */
import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { EventBus } from '../ports/events.js';
import type { Mailer } from '../ports/mailer.js';

export const RECONCILIATION_ALERT_EVENT = 'reconciliation.anomalies_found';

/**
 * 计数摘要（扫描 S-04）：同一天重跑对账、数字变了 → 新键，能再发一封；数字没变（作业重放）→ 同键，服务商去重。
 * @why 原先键只按日：Resend 文档说同一键 24 小时内配不同内容会被拒，最新结论就到不了运营手里（这一条未用真 key 实测）。
 */
function countsDigest(counts: ReadonlyArray<readonly [string, number]>): string {
  const text = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}=${String(n)}`)
    .join('&');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

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
      const r = await deps.mailer.send({
        to: deps.to,
        subject: `[Waselect] ${day} 对账发现 ${String(counts.length)} 类异常`,
        text:
          `每日对账（${event.at}）发现以下异常，需要人工处理：\n\n` +
          counts.map(([k, n]) => `${k}: ${String(n)}`).join('\n') +
          `\n\n取样订单 / 回调 id 见日志事件 reconciliation_anomaly。`,
        idempotencyKey: `reconciliation:${day}:${countsDigest(counts)}`,
        tag: RECONCILIATION_ALERT_EVENT,
      });
      // 扫描 S-02：按真实结果记（没配邮件服务时是 skipped），不把"只记了日志"写成"已发送"
      deps.logger.info('ops_alert_sent', {
        result: r.status,
        ctx: { day, classes: counts.length },
      });
    } catch (e) {
      deps.logger.error('ops_alert_failed', {
        result: 'failed',
        ctx: { day, error: e instanceof Error ? e.message : String(e) },
      });
    }
  });
}
