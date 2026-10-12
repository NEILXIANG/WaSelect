/**
 * 职责：daily 补发漏发的订单通知邮件（E-1 / AJ-419）——以订单 / 退款的**事实**为准，找"该有 sent 记录却没有"的，重发原事件。
 *
 * @why 以事实反查而不是只重试 failed 行：实时路径在"提交后、发信前"进程退出时，**连 failed 行都不会有**；
 *      只有从 orders.paid_at / shipped_at / refunded_at 与 order_refunds 反推，才找得到这类信。
 * @why 首次部署表为空时**一封都不补**：没有记录不等于没发过（上线前的单都没有记录），补了就是重复邮件。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { createSchedulerDeps } from './scheduler-start.js';
import { runSchedulerOnce } from './scheduler.js';
import type { DomainEvent } from '../ports/events.js';
import { MAIL_SWEEP_JOB, createMailSweepJob } from './mail-sweep.js';

const NOW = new Date('2026-10-09T03:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

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
  await db`insert into users (id, openid) values ('u-s', 'o-s')`;
});
afterEach(async () => {
  await db`delete from job_runs where name in (${MAIL_SWEEP_JOB}, 'sweep-test')`;
});

async function order(
  id: string,
  at: { paid?: Date; shipped?: Date; refunded?: Date },
  opts: { status?: string; email?: string | null } = {},
): Promise<void> {
  const status = opts.status ?? (at.refunded ? 'refunded' : at.shipped ? 'shipped' : 'paid');
  const email = opts.email === undefined ? 'jane.doe@example.com' : opts.email;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                        weight_g, fx_snapshot, address_snapshot, terms_version, expires_at,
                        contact_email, paid_at, shipped_at, refunded_at)
    values (${id}, ${`NO-${id}`}, 'u-s', ${status}, 1000, 0, 0, 1000, 500, '{}'::jsonb, '{}'::jsonb,
            'T', ${ago(72 * HOUR)}, ${email}, ${at.paid ?? null}, ${at.shipped ?? null}, ${at.refunded ?? null})`;
}

async function delivery(
  key: string,
  orderId: string,
  status: string,
  attempts = 1,
  firstAt = ago(HOUR),
) {
  await db`
    insert into mail_deliveries (idempotency_key, order_id, tag, status, attempts, first_at, last_at)
    values (${key}, ${orderId}, ${key.split(':')[0] ?? ''}, ${status}, ${attempts}, ${firstAt}, ${firstAt})`;
}

/** "表里已经有记录"的地板：一封三天前就记过的信（首次部署守卫靠它判断"记录从什么时候开始有"）。 */
async function floor(): Promise<void> {
  await order('o-floor', { paid: ago(72 * HOUR) });
  await delivery('order.paid:o-floor', 'o-floor', 'sent', 1, ago(72 * HOUR));
}

async function sweep(): Promise<DomainEvent[]> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const bus = createEventBus(logger);
  const seen: DomainEvent[] = [];
  // AJ-450：补发走专用事件 `mail.resend`（payload.tag 是原事件名），不再冒充业务事件
  bus.subscribe('mail.resend', (e) => {
    seen.push(e);
  });
  await runSchedulerOnce(
    createSchedulerDeps(db, bus, fixedClock(NOW.toISOString()), logger, {
      name: 'sweep-test',
      lockKey: 'sweep-test',
    }),
    [createMailSweepJob()],
  );
  await bus.drain(2000);
  return seen;
}

const keys = (events: DomainEvent[]): string[] =>
  events
    .map((e) => {
      const p = e.payload as { tag?: string; refund_id?: string } | undefined;
      expect(e.name).toBe('mail.resend');
      return p?.refund_id === undefined
        ? `${String(p?.tag)}:${String(e.orderId)}`
        : `${String(p?.tag)}:${String(e.orderId)}:${p.refund_id}`;
    })
    .sort();

describe('daily 补发漏发的订单通知邮件（E-1）', () => {
  it('🔴 首次部署（表里一条记录都没有）→ 一封都不补', async () => {
    await order('o-new', { paid: ago(HOUR) });
    expect(await sweep()).toEqual([]);
  });

  it('🔴 48 小时内、10 分钟前、留了邮箱、没有 sent 记录 → 重发原事件；已 sent 的不重发', async () => {
    await floor();
    await order('o-paid', { paid: ago(HOUR) });
    await order('o-shipped-lost', { paid: ago(30 * HOUR), shipped: ago(2 * HOUR) });
    await delivery('order.paid:o-shipped-lost', 'o-shipped-lost', 'sent');
    await order('o-done', { paid: ago(3 * HOUR), shipped: ago(2 * HOUR) });
    await delivery('order.paid:o-done', 'o-done', 'sent');
    await delivery('order.shipped:o-done', 'o-done', 'sent');
    expect(keys(await sweep())).toEqual(['order.paid:o-paid', 'order.shipped:o-shipped-lost']);
  });

  // 三天提交复查 2026-10-12：撤销发货后重新发货，实时路径用 `order.shipped:<id>:reship-1` 发新信；
  //   补发却只认 `order.shipped:<id>`——首封若失败，新运单号的信会被再发一遍（买家收到两封发货信）
  it('🔴 撤销后重新发货：补发认重新发货那封的键，不再补首封', async () => {
    await floor();
    await order('o-reship', { paid: ago(30 * HOUR), shipped: ago(HOUR) });
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-reship', 'shipment_reverted', 'x', 'admin:u-a', ${ago(2 * HOUR)})`;
    await delivery('order.paid:o-reship', 'o-reship', 'sent');
    await delivery('order.shipped:o-reship', 'o-reship', 'failed', 1);
    await delivery('order.shipped:o-reship:reship-1', 'o-reship', 'sent');
    expect(keys(await sweep())).toEqual([]);
    // 重新发货那封也失败了 → 补的是它（带 mail_key），不是首封
    await db`update mail_deliveries set status = 'failed' where idempotency_key = 'order.shipped:o-reship:reship-1'`;
    await db`update job_runs set last_processed = null where name = 'sweep-test'`;
    const again = await sweep();
    expect(again.map((e) => (e.payload as { mail_key?: string }).mail_key)).toEqual(['reship-1']);
  });

  it('🔴 failed 在重试上限内 → 补；到上限（5 次）→ 不再补（避免对一个坏地址天天发）', async () => {
    await floor();
    await order('o-retry', { paid: ago(HOUR) });
    await delivery('order.paid:o-retry', 'o-retry', 'failed', 2);
    await order('o-gave-up', { paid: ago(HOUR) });
    await delivery('order.paid:o-gave-up', 'o-gave-up', 'failed', 5);
    expect(keys(await sweep())).toEqual(['order.paid:o-retry']);
  });

  it('边界：10 分钟宽限内（实时路径可能还在途）与 48 小时之前的都不补；没留邮箱的不补', async () => {
    await floor();
    await order('o-too-fresh', { paid: ago(5 * MIN) });
    await order('o-too-old', { paid: ago(49 * HOUR) });
    await order('o-no-email', { paid: ago(HOUR) }, { email: null });
    expect(await sweep()).toEqual([]);
  });

  it('🔴 整单已退款 → 补 order.refunded；部分退款成功（单未退满）→ 补 order.partially_refunded 并带 refund_id', async () => {
    await floor();
    await order('o-refunded', { paid: ago(30 * HOUR), refunded: ago(HOUR) });
    await delivery('order.paid:o-refunded', 'o-refunded', 'sent');
    await order('o-partial', { paid: ago(30 * HOUR), shipped: ago(20 * HOUR) });
    await delivery('order.paid:o-partial', 'o-partial', 'sent');
    await delivery('order.shipped:o-partial', 'o-partial', 'sent');
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
             values ('pay-p', 'o-partial', 'mock', 'succeeded', 'JPY', 1000)`;
    await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, settled_at)
             values ('rf-1', 'o-partial', 'pay-p', 'JPY', 200, '破损', 'succeeded', 'admin:t', ${ago(HOUR)})`;
    expect(keys(await sweep())).toEqual([
      'order.partially_refunded:o-partial:rf-1',
      'order.refunded:o-refunded',
    ]);
  });
});
