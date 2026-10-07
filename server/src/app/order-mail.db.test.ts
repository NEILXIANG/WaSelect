/**
 * 职责：订单通知邮件订阅者（剩余清单 2-2）——真 Postgres 取单，假 Mailer 收信。
 * @why 订阅者的失败是**静默**的（只有一条 error 日志，请求照常成功），最容易漏测（business-events.ts @limitation 一）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import type { MailMessage, Mailer } from '../ports/mailer.js';
import { MAIL_EVENTS, registerOrderMail } from './order-mail.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-m', 'o-m')`;
});

async function seed(id: string, email: string | null) {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                        weight_g, fx_snapshot, address_snapshot, terms_version, expires_at,
                        contact_email, carrier, tracking_no)
    values (${id}, ${`WS${id}`}, 'u-m', 'shipped', 12800, 4950, null, 17750, 900, '{}'::jsonb, '{}'::jsonb,
            'T', now(), ${email}, 'EMS', 'EM123456789JP')`;
}

function setup(fail?: Error) {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const bus = createEventBus(logger);
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: (m) => {
      if (fail !== undefined) return Promise.reject(fail);
      sent.push(m);
      return Promise.resolve({ status: 'sent', id: `mail-${String(sent.length)}` });
    },
  };
  registerOrderMail(bus, { db, mailer, logger });
  return { sink, bus, sent };
}

const publish = async (bus: ReturnType<typeof createEventBus>, name: string, orderId: string) => {
  bus.publish({ name, at: '2026-10-06T00:00:00.000Z', orderId });
  expect(await bus.drain(2000)).toBe(0);
};

describe('订单通知邮件（2-2）', () => {
  it('订阅的正是四类：付款成功 / 已发货 / 部分退款（P2-12）/ 已退款', () => {
    expect([...MAIL_EVENTS]).toEqual([
      'order.paid',
      'order.shipped',
      'order.partially_refunded',
      'order.refunded',
    ]);
  });

  it('🔴 部分退款：每笔一封，幂等键带 refund_id（同一订单第二笔不会被服务商当成重放吞掉）', async () => {
    await seed('o-3', 'jane.doe@example.com');
    const { bus, sent } = setup();
    for (const rid of ['rf-a', 'rf-b']) {
      bus.publish({
        name: 'order.partially_refunded',
        at: '2026-10-06T00:00:00.000Z',
        orderId: 'o-3',
        payload: { refund_id: rid },
      });
    }
    expect(await bus.drain(2000)).toBe(0);
    expect(sent.map((m) => m.idempotencyKey)).toEqual([
      'order.partially_refunded:o-3:rf-a',
      'order.partially_refunded:o-3:rf-b',
    ]);
    expect(sent[0]?.subject).toContain('Partial refund');
  });

  it('🔴 已发货：发给 contact_email，正文含单号、承运商与运单号；幂等键 = 事件:订单', async () => {
    await seed('o-1', 'jane.doe@example.com');
    const { bus, sent, sink } = setup();
    await publish(bus, 'order.shipped', 'o-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('jane.doe@example.com');
    expect(sent[0]?.subject).toContain('WSo-1');
    expect(sent[0]?.text).toContain('EMS');
    expect(sent[0]?.text).toContain('EM123456789JP');
    expect(sent[0]?.idempotencyKey).toBe('order.shipped:o-1');
    // 业务日志能回答"发了没有"，但日志里没有邮箱
    expect(sink.find('order_mail_sent')).toHaveLength(1);
    expect(JSON.stringify(sink.lines)).not.toContain('jane.doe');
  });

  it('付款成功 / 已退款各发一封，主题各不相同', async () => {
    await seed('o-2', 'taro@example.com');
    const { bus, sent } = setup();
    await publish(bus, 'order.paid', 'o-2');
    await publish(bus, 'order.refunded', 'o-2');
    expect(sent.map((m) => m.tag)).toEqual(['order.paid', 'order.refunded']);
    expect(new Set(sent.map((m) => m.subject)).size).toBe(2);
  });

  it('没留邮箱 → 不发，记 order_mail_skipped（no_email）', async () => {
    await seed('o-3', null);
    const { bus, sent, sink } = setup();
    await publish(bus, 'order.shipped', 'o-3');
    expect(sent).toHaveLength(0);
    expect((sink.find('order_mail_skipped')[0]?.['ctx'] as { reason?: string }).reason).toBe(
      'no_email',
    );
  });

  it('🔴 服务商失败 → 记 error（order_mail_failed），不抛出到总线、不含邮箱', async () => {
    await seed('o-4', 'jane.doe@example.com');
    const { bus, sink } = setup(new Error('resend 发送失败：HTTP 500'));
    await publish(bus, 'order.shipped', 'o-4');
    const err = sink.find('order_mail_failed');
    expect(err).toHaveLength(1);
    expect(err[0]?.['level']).toBe('error');
    expect(sink.find('domain_event_subscriber_failed')).toHaveLength(0);
    expect(JSON.stringify(sink.lines)).not.toContain('jane.doe');
  });
});
