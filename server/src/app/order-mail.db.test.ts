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
  it('订阅的正是五类：付款成功 / 已发货 / 撤销发货更正（AJ-440）/ 部分退款（P2-12）/ 已退款', () => {
    expect([...MAIL_EVENTS]).toEqual([
      'order.paid',
      'order.shipped',
      'order.shipment_reverted',
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

  it('🔴 AJ-450 补发事件 mail.resend：按 payload.tag 发信，幂等键与首发完全一致（服务商侧仍能去重）', async () => {
    await seed('o-6', 'jane.doe@example.com');
    const { bus, sent } = setup();
    bus.publish({
      name: 'mail.resend',
      at: '2026-10-11T00:00:00.000Z',
      orderId: 'o-6',
      payload: { tag: 'order.shipped' },
    });
    bus.publish({
      name: 'mail.resend',
      at: '2026-10-11T00:00:00.000Z',
      orderId: 'o-6',
      payload: { tag: 'order.partially_refunded', refund_id: 'rf-z' },
    });
    expect(await bus.drain(2000)).toBe(0);
    expect(sent.map((m) => m.idempotencyKey).sort()).toEqual([
      'order.partially_refunded:o-6:rf-z',
      'order.shipped:o-6',
    ]);
    expect(sent.find((m) => m.tag === 'order.shipped')?.subject).toContain('has shipped');
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

  it('🔴 撤销发货（AJ-440）：发更正信，幂等键带 revert-<n>，正文不复述原运单号', async () => {
    await seed('o-5', 'jane.doe@example.com');
    const { bus, sent } = setup();
    for (const k of ['revert-1', 'revert-2']) {
      bus.publish({
        name: 'order.shipment_reverted',
        at: '2026-10-10T00:00:00.000Z',
        orderId: 'o-5',
        payload: { mail_key: k },
      });
    }
    expect(await bus.drain(2000)).toBe(0);
    // 两封并发发出、先后不定（订阅者 async、总线发后不等）：按集合比
    expect(sent.map((m) => m.idempotencyKey).sort()).toEqual([
      'order.shipment_reverted:o-5:revert-1',
      'order.shipment_reverted:o-5:revert-2',
    ]);
    expect(sent[0]?.subject).toContain('has not shipped yet');
    expect(sent[0]?.text).not.toContain('EM123456789JP');
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

/**
 * E-1（工程分析 2026-10-08）：每次发信的结果落 `mail_deliveries`，daily 补发据此找"该发没发成"的。
 * @why 事件总线发后不等、进程内（event-bus.ts @limitation 一/二）；邮件是买家唯一的主动通知——
 *      不留记录就无从知道哪封没到。记录里**不放邮箱**（约束七），只放订单、事件与结果。
 */
describe('发信记录（mail_deliveries，E-1）', () => {
  const row = async (key: string) =>
    (
      await db`select order_id, tag, status, attempts, last_error from mail_deliveries
                where idempotency_key = ${key}`
    )[0];

  it('🔴 发成功 → 一行 sent、attempts=1，键 = 幂等键', async () => {
    await seed('o-5', 'jane.doe@example.com');
    const { bus } = setup();
    await publish(bus, 'order.shipped', 'o-5');
    expect(await row('order.shipped:o-5')).toEqual({
      order_id: 'o-5',
      tag: 'order.shipped',
      status: 'sent',
      attempts: 1,
      last_error: null,
    });
  });

  it('🔴 服务商失败 → failed，错误信息里的邮箱被打码；再发成功 → sent、attempts=2', async () => {
    await seed('o-6', 'jane.doe@example.com');
    const failing = setup(new Error('invalid recipient jane.doe@example.com'));
    await publish(failing.bus, 'order.paid', 'o-6');
    const failed = await row('order.paid:o-6');
    expect(failed?.['status']).toBe('failed');
    expect(String(failed?.['last_error'])).not.toContain('jane.doe@');
    const ok = setup();
    await publish(ok.bus, 'order.paid', 'o-6');
    expect(await row('order.paid:o-6')).toMatchObject({
      status: 'sent',
      attempts: 2,
      last_error: null,
    });
  });

  it('已经 sent 的不会被后来的失败降级回 failed（补发与实时同时到时以成功为准）', async () => {
    await seed('o-7', 'jane.doe@example.com');
    await publish(setup().bus, 'order.refunded', 'o-7');
    await publish(setup(new Error('HTTP 500')).bus, 'order.refunded', 'o-7');
    expect(await row('order.refunded:o-7')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('没留邮箱 → skipped（补发不会去捞它）', async () => {
    await seed('o-8', null);
    await publish(setup().bus, 'order.shipped', 'o-8');
    expect((await row('order.shipped:o-8'))?.['status']).toBe('skipped');
  });
});
