/**
 * 退款进展回调落账（审计 PAY-03，2026-10-14，AJ-530）：真库，覆盖部分退款 / 整单退款 / 失败 / 对不上四条路径。
 * @why 契约订阅了 refund.updated / refund.failed，原先没有落账器：本系统发起的 pending 退款只能等管理员再点一次去查，
 *      机构侧失败也无人知道。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { closeDb, type Db } from '../adapters/db.js';
import { createLogger } from '../logger.js';
import { createEventBus } from '../adapters/event-bus.js';
import { insertPartialRefund, settlePartialRefund } from '../adapters/order-refunds.js';
import { applyProviderRefundProgress } from './refund-progress.js';

let db: Db;
const clock = fixedClock('2026-10-14T03:00:00.000Z');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

function deps() {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  return { d: { db, logger, clock, events: createEventBus(logger) }, sink };
}

async function seedOrder(id: string, status: string): Promise<void> {
  await db`insert into users (id, openid) values ('u-rp', 'o-rp') on conflict do nothing`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at, paid_at)
    values (${id}, ${`W-${id}`}, 'u-rp', ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now(), now())`;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values (${`pay-${id}`}, ${id}, 'stripe', ${`cs_${id}`}, 'succeeded', 'USD', 8160)`;
}

const statusOf = async (id: string) =>
  String((await db`select status from orders where id = ${id}`)[0]?.['status']);

beforeEach(async () => {
  await resetTestDb(db);
});

describe('applyProviderRefundProgress', () => {
  it('🔴 部分退款 pending + 机构 succeeded → 行落定 succeeded，记 partial_refunded 事件', async () => {
    await seedOrder('o-pp', 'delivered');
    await insertPartialRefund(db, {
      id: 'rf-pp',
      orderId: 'o-pp',
      paymentId: 'pay-o-pp',
      currency: 'USD',
      amountMinor: 1000,
      reason: '破损',
      actor: 'admin:u-a',
    });
    await settlePartialRefund(db, 'rf-pp', 'pending', 're_pp', clock.now());
    const out = await applyProviderRefundProgress(deps().d, {
      orderId: 'o-pp',
      channel: 'stripe',
      refundRef: 're_pp',
      outcome: 'succeeded',
    });
    expect(out).toBe('partial');
    const [r] = await db`select status from order_refunds where id = 'rf-pp'`;
    expect(r?.['status']).toBe('succeeded');
    const ev =
      await db`select note from order_events where order_id = 'o-pp' and status = 'partial_refunded'`;
    expect(ev).toHaveLength(1);
  });

  it('🔴 整单退款 refunding + 在途单号匹配 + 机构 succeeded → 订单 refunded、支付行 refunded', async () => {
    await seedOrder('o-full', 'refunding');
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-full', 'refunding', '买家要求退款', 'admin:u-a', now()),
                    ('o-full', 'refund_pending', 're_full', 'admin:u-a', now())`;
    const out = await applyProviderRefundProgress(deps().d, {
      orderId: 'o-full',
      channel: 'stripe',
      refundRef: 're_full',
      outcome: 'succeeded',
    });
    expect(out).toBe('full');
    expect(await statusOf('o-full')).toBe('refunded');
    const [p] = await db`select status from payments where id = 'pay-o-full'`;
    expect(p?.['status']).toBe('refunded');
  });

  it('🔴 整单退款机构 failed → 记 refund_failed provider_failed:<单号>，订单仍 refunding（下次点击换新键）', async () => {
    await seedOrder('o-fail', 'refunding');
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-fail', 'refunding', '缺货', 'admin:u-a', now()),
                    ('o-fail', 'refund_pending', 're_fail', 'admin:u-a', now())`;
    await applyProviderRefundProgress(deps().d, {
      orderId: 'o-fail',
      channel: 'stripe',
      refundRef: 're_fail',
      outcome: 'failed',
    });
    expect(await statusOf('o-fail')).toBe('refunding');
    const ev =
      await db`select note from order_events where order_id = 'o-fail' and status = 'refund_failed'`;
    expect(ev.map((e) => e['note'])).toEqual(['provider_failed:re_fail']);
  });

  it('对不上（单号不是在途那笔 / 订单不在退款中）→ noop，不改任何东西', async () => {
    await seedOrder('o-x', 'paid');
    const out = await applyProviderRefundProgress(deps().d, {
      orderId: 'o-x',
      channel: 'stripe',
      refundRef: 're_unknown',
      outcome: 'succeeded',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-x')).toBe('paid');
  });

  it('pending → noop（等下一条进展）', async () => {
    await seedOrder('o-pd', 'refunding');
    expect(
      await applyProviderRefundProgress(deps().d, {
        orderId: 'o-pd',
        channel: 'stripe',
        refundRef: 're_pd',
        outcome: 'pending',
      }),
    ).toBe('noop');
  });
});
