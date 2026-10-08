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
    // 就位信号用"锁真的拿到了"，不用 `setTimeout(50)` 猜（AJ-177）
    let locked: () => void = () => {};
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.begin(async (tx) => {
      await tx`select id from orders where id = 'o-mp' for update`;
      locked();
      await new Promise((r) => setTimeout(r, 300));
    });
    await ready;
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
    const evs = await db`select status, actor from order_events where order_id = 'o-mp'`;
    expect(evs).toHaveLength(1);
    // actor 口径 `provider:<channel>`（技术文档 order_events.actor；一致性审计 C3，AJ-176）
    expect(evs[0]?.['actor']).toBe('provider:mock');
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

describe('并发换通道：核对取在途那一行，不取被作废的（第三轮缺口 P1-3）', () => {
  /**
   * @why `payments.created_at` 默认 `now()` = **事务开始**时刻。买家连点两个通道时，后拿到订单锁的一方
   *      新插的行时间反而更早，被它作废的旧行更晚——按 `created_at desc` 取到的是已作废那行，
   *      付款成功的回调被判 `channel_mismatch`，钱扣了、单停在待付款直到过期。
   */
  it('🔴 initiated 行 created_at 更早、cancelled 行更晚 → 按 initiated 那行核对并落账', async () => {
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, created_at)
      values ('pay-live', 'o-mp', 'mock', 'cs_test_intent_1', 'initiated', ${CHARGE.currency}, ${CHARGE.amountMinor}, now() - interval '2 seconds'),
             ('pay-void', 'o-mp', 'stripe', 'cs_test_void', 'cancelled', 'USD', 700, now() - interval '1 second')`;
    await db`update orders set status = 'pending_payment' where id = 'o-mp'`;
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK);
    const [o] = await db`select status from orders where id = 'o-mp'`;
    expect(o?.['status']).toBe('paid');
    const [p] = await db`select status from payments where id = 'pay-live'`;
    expect(p?.['status']).toBe('succeeded');
  });
});

describe('迟到付款也要先核对金额（第三轮缺口 P2-3）', () => {
  /**
   * @why 本机实测：对已关单发一条**金额不符**的签名回调 → 归为 late_payment 并记 late_paid 凭据，
   *      管理端随后按支付行 charge_amount 全额退款，而实收是另一个数。核对必须先于迟到判定。
   */
  it('🔴 已关单 + 金额不符 → amount_mismatch（不是 late_payment）', async () => {
    await seedIntent('o-mp');
    await db`update payments set status = 'cancelled' where order_id = 'o-mp'`;
    await db`update orders set status = 'expired' where id = 'o-mp'`;
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', {
        ...OK,
        amountMinor: 1,
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'amount_mismatch' } });
  });

  it('已关单 + 金额相符 → 仍是 late_payment', async () => {
    await seedIntent('o-mp');
    await db`update payments set status = 'cancelled' where order_id = 'o-mp'`;
    await db`update orders set status = 'expired' where id = 'o-mp'`;
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'late_payment' } });
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
    // 唯一允许的事件：迟到付款凭据（剩余清单 1-5），带机构单号，供管理端退款
    const evs = await db`select status, note from order_events where order_id = 'o-late'`;
    expect(evs.map((e) => ({ ...e }))).toEqual([{ status: 'late_paid', note: OK.providerRef }]);
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

  it('🔴 窗口内付款、回调晚到（M-01）：付款时刻早于 expires_at → 正常落账，不判迟到', async () => {
    await seedOrderAt('o-slow', 'pending_payment', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-slow');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:30:05.000Z'), 'o-slow', {
      ...OK,
      occurredAtMs: Date.parse('2026-01-02T00:29:59.000Z'),
    });
    expect((await db`select status from orders where id = 'o-slow'`)[0]?.status).toBe('paid');
  });

  it('付款时刻本身已过 expires_at → 仍是迟到（机构时刻只放宽"通知晚到"，不放宽"付晚了"）', async () => {
    await seedOrderAt('o-late2', 'pending_payment', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-late2');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:30:05.000Z'), 'o-late2', {
        ...OK,
        occurredAtMs: Date.parse('2026-01-02T00:30:01.000Z'),
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'late_payment' } });
  });

  it('机构时刻在"未来"（时钟偏差）→ 按我方当前时刻判定，不能借未来时刻绕开', async () => {
    await seedOrderAt('o-skew', 'pending_payment', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-skew');
    const { events } = bus();
    await expect(
      markOrderPaid(db, events, fixedClock('2026-01-02T00:30:05.000Z'), 'o-skew', {
        ...OK,
        occurredAtMs: Date.parse('2026-01-02T01:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 40902, details: { reason: 'late_payment' } });
  });

  it('边界：expires_at 前 1ms → 正常落账', async () => {
    await seedOrderAt('o-edge2', 'created', '2026-01-02T00:30:00.000Z');
    await seedIntent('o-edge2');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:29:59.999Z'), 'o-edge2', OK);
    expect((await db`select status from orders where id = 'o-edge2'`)[0]?.status).toBe('paid');
  });

  it.each(['expired', 'cancelled'] as const)(
    '已 %s 的单到账 → 40902{reason:late_payment}（关单作业先跑掉/用户已取消：与"到点未关"同一分类，KD-7）',
    async (closedAs) => {
      await seedOrderAt(`o-closed-${closedAs}`, closedAs, '2026-01-02T00:30:00.000Z');
      // 关单时 initiated 行被作废（close-session-events）：迟到判定前要先核对它（P2-3），没有支付行就是 no_payment_intent
      await seedIntent(`o-closed-${closedAs}`);
      await db`update payments set status = 'cancelled' where order_id = ${`o-closed-${closedAs}`}`;
      const { events } = bus();
      await expect(
        markOrderPaid(
          db,
          events,
          fixedClock('2026-01-02T00:31:00.000Z'),
          `o-closed-${closedAs}`,
          OK,
        ),
      ).rejects.toMatchObject({
        code: 40902,
        details: { from: closedAs, reason: 'late_payment' },
      });
      // 拒落账：订单状态纹丝不动
      expect(
        (await db`select status from orders where id = ${`o-closed-${closedAs}`}`)[0]?.status,
      ).toBe(closedAs);
    },
  );
});

/**
 * 订单已付后又来一笔"支付成功"（M-02）：只有能证明是**同一笔钱**时才算重复通知。
 * @why 原实现订单一旦 paid，任何成功回调都直接抛 {from:'paid'} → 管线记 info 级 paid:already、不进对账。
 *      换通道后旧的 Stripe 页面又被付了一次（或 A→B→A 付了旧会话），那是**第二笔真实扣款**，被静默吞掉。
 */
describe('已付订单上的第二笔支付（M-02）', () => {
  async function paidFirst(): Promise<void> {
    await seedIntent('o-mp');
    const { events } = bus();
    await markOrderPaid(db, events, fixedClock('2026-01-02T00:00:00.000Z'), 'o-mp', OK);
  }
  const again = async (s: PaidSettlement): Promise<unknown> => {
    const { events } = bus();
    return markOrderPaid(db, events, fixedClock('2026-01-02T00:01:00.000Z'), 'o-mp', s).catch(
      (e: unknown) => e,
    );
  };

  it('同一笔钱的重复通知（同通道、同单号）→ 仍是 {from:paid}，不带 reason', async () => {
    await paidFirst();
    const err = (await again(OK)) as { code: number; details: Record<string, unknown> };
    expect(err.code).toBe(40902);
    expect(err.details['from']).toBe('paid');
    expect(err.details['reason']).toBeUndefined();
  });

  it('🔴 另一个通道的支付成功 → duplicate_payment（真实的第二笔扣款，必须进对账）', async () => {
    await paidFirst();
    const err = (await again({ ...OK, channel: 'stripe', providerRef: 'cs_test_other' })) as {
      details: Record<string, unknown>;
    };
    expect(err.details['reason']).toBe('duplicate_payment');
  });

  it('🔴 同通道、同 id 族但单号不同（付了旧会话）→ duplicate_payment', async () => {
    await paidFirst();
    const err = (await again({ ...OK, providerRef: 'cs_test_intent_OLD' })) as {
      details: Record<string, unknown>;
    };
    expect(err.details['reason']).toBe('duplicate_payment');
  });

  it('🔴 已退款（payments.status=refunded）的单又来另一通道的成功回调 → 仍判 duplicate_payment（审查 2026-10-09 C15）', async () => {
    await paidFirst();
    await db`update payments set status = 'refunded' where order_id = 'o-mp'`;
    await db`update orders set status = 'refunded' where id = 'o-mp'`;
    const err = (await again({ ...OK, channel: 'stripe', providerRef: 'cs_test_other' })) as {
      details: Record<string, unknown>;
    };
    // `in ('succeeded','refunded')` 少了 refunded ⇒ rows 为空 ⇒ 按原分支 {from} 静默吞掉第二笔真实扣款
    expect(err.details['reason']).toBe('duplicate_payment');
  });

  it('同通道、跨 id 族（登记 cs_、事件回带 pi_）→ 无法比对，按重复通知处理（Stripe 同一笔钱两种事件是常态）', async () => {
    await paidFirst();
    const err = (await again({ ...OK, providerRef: 'pi_test_123' })) as {
      details: Record<string, unknown>;
    };
    expect(err.details['from']).toBe('paid');
    expect(err.details['reason']).toBeUndefined();
  });

  it('订单不在可付状态、但没有任何已收款支付行（数据异常）→ 不判"另一笔"，按原分支 {from}', async () => {
    await db`update orders set status = 'shipped' where id = 'o-mp'`;
    const err = (await again(OK)) as { details: Record<string, unknown> };
    expect(err.details['from']).toBe('shipped');
    expect(err.details['reason']).toBeUndefined();
  });

  it('同通道、回调没带单号 → 无法比对，按重复通知处理', async () => {
    await paidFirst();
    const err = (await again({ ...OK, providerRef: '' })) as { details: Record<string, unknown> };
    expect(err.details['from']).toBe('paid');
    expect(err.details['reason']).toBeUndefined();
  });
});
