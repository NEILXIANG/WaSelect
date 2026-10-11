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
    // S-6（AJ-460）：日期按日本时间（18:00Z 已是 JST 10-07），与运营看到的页面同口径
    expect(sent[0]?.subject).toContain('2026-10-07');
    expect(sent[0]?.subject).not.toContain('2026-10-06');
    expect(sent[0]?.subject).toContain('2');
    expect(sent[0]?.text).toContain('stuck_refunds: 2');
    expect(sent[0]?.text).toContain('callback_anomalies_48h: 1');
    expect(sent[0]?.text).not.toContain('dangling_payments');
    // 扫描 S-04：键带计数摘要——同一天重跑、数字变了要能再发；数字没变（重放）仍去重
    expect(sent[0]?.idempotencyKey).toMatch(/^reconciliation:2026-10-07:[0-9a-f]{12}$/);
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

describe('告警邮件幂等键与发送结果（扫描 S-02 / S-04）', () => {
  it('🔴 同一天两次对账：计数相同 → 同一个键；计数不同 → 不同的键', async () => {
    const { bus, sent } = setup('ops@example.com');
    bus.publish(EVENT);
    bus.publish(EVENT);
    bus.publish({ ...EVENT, payload: { stuck_refunds: 3 } });
    await bus.drain(1000);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(sent[2]?.idempotencyKey).not.toBe(sent[0]?.idempotencyKey);
  });

  it('🔴 邮件服务没配（mailer 回 skipped）→ 日志记 skipped，不记"已发送"', async () => {
    const sink = new MemorySink();
    const logger = createLogger({ env: 'test', destination: sink });
    const bus = createEventBus(logger);
    registerOpsAlertMail(bus, {
      logger,
      to: 'ops@example.com',
      mailer: { send: () => Promise.resolve({ status: 'skipped', reason: 'no_provider' }) },
    });
    bus.publish(EVENT);
    await bus.drain(1000);
    expect(sink.find('ops_alert_sent')[0]?.['result']).toBe('skipped');
  });
});
