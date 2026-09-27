/**
 * 职责：`markOrderPaid` 的真库测试——并发落账只能成功一次、`paid_at` 与事件时间同源，
 *      以及**落账必须绑定通道与金额**（三审 S1② / U1）。
 *
 * @why 三审变异 D11 存活：删掉 `for update` 后全仓仍全绿。Stripe 会对同一单发
 *      `payment_intent.succeeded` 与 `checkout.session.completed` **两个 event_id**，
 *      webhook 租约按 event_id 隔离，**不会**串行化它们——只有行锁能保证两次并发落账
 *      不都读到 `created`。fake store / e2e 都没有把"两个事务同时进入"这件事摆出来。
 *
 * @why 核对这一组必须用**真库**：`payments` 的部分唯一索引（一张单一笔 initiated）、
 *      `payments_status_domain`（succeeded 合法）、事务里两处写要么都成要么都不成
 *      ——这三条没有一条能在 fake 上验出来。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createLogger } from '../logger.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { recordPaymentIntent } from './payment-intent.js';
import { markOrderPaid, type PaidSettlement } from './mark-paid.js';

let db: Db;

/** fixture 里"机构说它收了多少"。 */
const CHARGE = { currency: 'JPY', amountMinor: 1000 };
/** fixture 里"我们登记了什么"。 */
const INTENT = {
  provider: 'mock',
  providerRef: 'cs_test_intent_1',
  chargeCurrency: CHARGE.currency,
  chargeAmount: CHARGE.amountMinor,
};
/** 与 INTENT 对得上的回调自述。 */
const OK: PaidSettlement = {
  channel: 'mock',
  providerRef: 'cs_test_intent_1',
  amountMinor: CHARGE.amountMinor,
  currency: CHARGE.currency,
};

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-mp', 'o-mp')`;
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values ('o-mp', 'W-MP-1', 'u-mp', 'created', 1000, 0, 0, 1000, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
});

async function seedOrder(id: string): Promise<void> {
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values (${id}, ${`W-${id}`}, 'u-mp', 'created', 1000, 0, 0, 1000, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
}

/** 走**真函数**登记支付期望（不裸写 SQL：写入路径必须与生产一致）。 */
async function seedIntent(orderId: string, over: Partial<typeof INTENT> = {}): Promise<void> {
  await recordPaymentIntent(db, { id: `pay-${orderId}`, orderId, ...INTENT, ...over });
}

function bus() {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  return { events: createEventBus(logger), sink };
}

describe('markOrderPaid（真库）', () => {
  it('两个并发落账：恰一个成功、另一个 40902{from:paid}；order_events 恰 1 行、order.paid 恰 1 次', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    let paidEvents = 0;
    events.subscribe('order.paid', () => {
      paidEvents += 1;
    });
    const clock = fixedClock('2026-01-02T00:00:00.000Z');
    // 制造确定性的交错：外部事务先持有行锁 300ms（不改数据）。有 `for update` 时两次落账
    // 都在 select 处排队，先到者提交后后到者读到 paid；没有 `for update` 时两者都立即读到
    // `created`，随后各自 update → 两条 paid 事件（三审变异 D11 就是这样存活的）。
    const holder = db.begin(async (tx) => {
      await tx`select id from orders where id = 'o-mp' for update`;
      await new Promise((r) => setTimeout(r, 300));
    });
    await new Promise((r) => setTimeout(r, 50));
    const results = await Promise.allSettled([
      markOrderPaid(db, events, clock, 'o-mp', OK),
      markOrderPaid(db, events, clock, 'o-mp', OK),
    ]);
    await holder;
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 40902,
      details: { from: 'paid' },
    });
    const evs = await db`select status from order_events where order_id = 'o-mp'`;
    expect(evs).toHaveLength(1);
    expect(paidEvents).toBe(1);
  });

  it('paid_at 取注入时钟（与 order.paid 事件的 at 同源，而不是 DB now()）', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    let at = '';
    events.subscribe('order.paid', (e) => {
      at = e.at;
    });
    const clock = fixedClock('2026-01-02T03:04:05.000Z');
    await markOrderPaid(db, events, clock, 'o-mp', OK);
    const rows = await db`select paid_at, status from orders where id = 'o-mp'`;
    expect(rows[0]?.status).toBe('paid');
    expect((rows[0]?.paid_at as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('订单不存在 → 40400（管线据此走早到/未匹配分层）', async () => {
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'nope', OK),
    ).rejects.toMatchObject({ code: 40400 });
  });
});

describe('落账绑定通道与金额（三审 S1② / U1）', () => {
  it('通道不符 → 40902 channel_mismatch，不置 paid、不写事件', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        channel: 'stripe',
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'channel_mismatch' } });
    const rows = await db`select status from orders where id = 'o-mp'`;
    expect(rows[0]?.status).toBe('created');
    expect(await db`select 1 from order_events where order_id = 'o-mp'`).toHaveLength(0);
  });

  it('金额不符 → 40902 amount_mismatch（少收也不发货）', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        amountMinor: 990,
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'amount_mismatch' } });
  });

  it('币种不符 → 40902 currency_mismatch', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'currency_mismatch' } });
  });

  it('机构单号不符 → 40902 provider_ref_mismatch', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        providerRef: 'cs_test_another',
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'provider_ref_mismatch' } });
  });

  it('无下划线的机构单号（自定义 ref 形态）同族硬比：不同即 provider_ref_mismatch', async () => {
    await seedIntent('o-mp', { providerRef: 'REF0001' });
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        providerRef: 'REF0002',
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'provider_ref_mismatch' } });
  });

  it('机构单号跨 id 族（登记 cs_、事件回带 pi_）→ 不比单号，凭通道/币种/金额落账（Stripe PI 事件先到是常态）', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
      ...OK,
      providerRef: 'pi_3Habcdef',
    });
    const rows = await db`select status from orders where id = 'o-mp'`;
    expect(rows[0]?.status).toBe('paid');
  });

  it('⛔ 从未发起过支付（无 payments 行）→ 落账被拒：持任一通道密钥也不能凭空置 paid', async () => {
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'no_payment_intent' } });
  });

  it('回调没报金额/币种 → settlement_unverifiable（不可核对就不落账，不按我方值放行）', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        amountMinor: undefined,
        currency: undefined,
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'settlement_unverifiable' } });
  });

  it('核对通过 → 订单置 paid 且 payments 行封口为 succeeded（两本账一起提交）', async () => {
    await seedIntent('o-mp');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK);
    const p =
      await db`select status, paid_amount, paid_currency, transaction_id from payments where order_id = 'o-mp'`;
    expect(p[0]?.status).toBe('succeeded');
    expect(Number(p[0]?.paid_amount)).toBe(CHARGE.amountMinor);
    expect(p[0]?.paid_currency).toBe(CHARGE.currency);
    expect(p[0]?.transaction_id).toBe(INTENT.providerRef);
  });

  it('同一订单重复登记支付期望 → 40902（一张单同时只能有一笔在途）', async () => {
    await seedIntent('o-mp');
    await expect(seedIntent('o-mp', { providerRef: 'cs_test_2' })).rejects.toMatchObject({
      code: 40902,
    });
  });

  it('另一张单的支付期望不能给这张单用（期望按 order_id 取）', async () => {
    await seedOrder('o-other');
    await seedIntent('o-other');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'no_payment_intent' } });
  });
});

describe('I1-U2：pending_payment 迁移与迟到付款守卫（D-33）', () => {
  /** 造一张指定状态/到期时间的单。 */
  async function seedOrderAt(id: string, status: string, expiresAt: string): Promise<void> {
    await db`
      insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, weight_g,
                          fx_snapshot, address_snapshot, terms_version, expires_at)
      values (${id}, ${`W-${id}`}, 'u-mp', ${status}, 1000, 1000, 500,
              '{}'::jsonb, '{}'::jsonb, 'T', ${expiresAt})
    `;
  }

  it('pending_payment → paid（业务期主路径：支付意图已发起后的回调落账）', async () => {
    await seedOrderAt('o-pp', 'pending_payment', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-pp');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:05:00.000Z'), 'o-pp', OK);
    const rows = await db`select status from orders where id = 'o-pp'`;
    expect(rows[0]?.status).toBe('paid');
  });

  it('迟到付款：created 但已过 expires_at → 40902 late_payment，不落账、不封口、不发事件', async () => {
    await seedOrderAt('o-late', 'created', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-late');
    const { events } = bus();
    let paidEvents = 0;
    events.subscribe('order.paid', () => {
      paidEvents += 1;
    });
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:31:00.000Z'), 'o-late', OK),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'late_payment' } });
    // 订单不动、payments 行不封口（对账要靠 status='initiated' 找到它）、无 order.paid 事件
    expect((await db`select status from orders where id = 'o-late'`)[0]?.status).toBe('created');
    expect((await db`select status from payments where order_id = 'o-late'`)[0]?.status).toBe(
      'initiated',
    );
    expect(await db`select 1 from order_events where order_id = 'o-late'`).toHaveLength(0);
    expect(paidEvents).toBe(0);
  });

  it('边界：now 恰好等于 expires_at → 迟到（可支付窗口是 [created, expires_at)，与关单 job 同向）', async () => {
    await seedOrderAt('o-edge', 'created', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-edge');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:30:00.000Z'), 'o-edge', OK),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'late_payment' } });
  });

  it('边界：expires_at 前 1ms → 正常落账', async () => {
    await seedOrderAt('o-edge2', 'created', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-edge2');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:29:59.999Z'), 'o-edge2', OK);
    expect((await db`select status from orders where id = 'o-edge2'`)[0]?.status).toBe('paid');
  });

  it('已 expired 的单 → 40902{from:expired}（关单 job 先跑掉的情形，走普通冲突分层）', async () => {
    await seedOrderAt('o-closed', 'expired', '2026-01-02T00:30:00.000Z');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:31:00.000Z'), 'o-closed', OK),
    ).rejects.toMatchObject({ code: 40902, details: { from: 'expired' } });
  });
});
