/**
 * 职责：对账异常告警邮件订阅者（剩余清单 2-4）。
 * @see ./ops-alert-mail.ts
 */
import { describe, expect, it } from 'vitest';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { createEventBus } from '../adapters/event-bus.js';
import type { MailMessage, Mailer } from '../ports/mailer.js';
import { RECONCILIATION_ALERT_EVENT, registerOpsAlertMail } from './ops-alert-mail.js';

function setup(to: string | undefined, fail = false) {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const bus = createEventBus(logger);
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: (m) => {
      if (fail) return Promise.reject(new Error('HTTP 500'));
      sent.push(m);
      return Promise.resolve({ status: 'sent', id: 'x' });
    },
  };
  registerOpsAlertMail(bus, { mailer, logger, to });
  return { sink, bus, sent };
}

const EVENT = {
  name: RECONCILIATION_ALERT_EVENT,
  at: '2026-10-06T18:00:00.000Z',
  payload: { stuck_refunds: 2, dangling_payments: 0, callback_anomalies_48h: 1 },
};

describe('对账异常告警邮件（2-4）', () => {
  it('🔴 有收件人 → 发一封：主题带日期与异常类数，正文只列非零的类；幂等键按日', async () => {
    const { bus, sent } = setup('ops@example.com');
    bus.publish(EVENT);
    expect(await bus.drain(1000)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ops@example.com');
    expect(sent[0]?.subject).toContain('2026-10-06');
    expect(sent[0]?.subject).toContain('2');
    expect(sent[0]?.text).toContain('stuck_refunds: 2');
    expect(sent[0]?.text).toContain('callback_anomalies_48h: 1');
    expect(sent[0]?.text).not.toContain('dangling_payments');
    expect(sent[0]?.idempotencyKey).toBe('reconciliation:2026-10-06');
  });

  it('没配 ALERT_EMAIL → 不发，记 ops_alert_skipped', async () => {
    const { bus, sent, sink } = setup(undefined);
    bus.publish(EVENT);
    await bus.drain(1000);
    expect(sent).toHaveLength(0);
    expect(sink.find('ops_alert_skipped')).toHaveLength(1);
  });

  it('发送失败 → error 日志 ops_alert_failed，不抛给总线', async () => {
    const { bus, sink } = setup('ops@example.com', true);
    bus.publish(EVENT);
    await bus.drain(1000);
    expect(sink.find('ops_alert_failed')).toHaveLength(1);
    expect(sink.find('domain_event_subscriber_failed')).toHaveLength(0);
  });
});
