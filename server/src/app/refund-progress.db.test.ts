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
import { settleFullRefundFromProvider } from './refund-execution.js';

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

  it('🔴 已落定成功的退款又被机构报 failed → 不改账，但打 error 日志（钱可能没到买家手里，要人看；四天提交复查 2026-10-16）', async () => {
    // 部分退款：行已 succeeded
    await seedOrder('o-sf', 'delivered');
    await insertPartialRefund(db, {
      id: 'rf-sf',
      orderId: 'o-sf',
      paymentId: 'pay-o-sf',
      currency: 'USD',
      amountMinor: 1000,
      reason: '破损',
      actor: 'admin:u-a',
    });
    await settlePartialRefund(db, 'rf-sf', 'succeeded', 're_sf', clock.now());
    const a = deps();
    expect(
      await applyProviderRefundProgress(a.d, {
        orderId: 'o-sf',
        channel: 'stripe',
        refundRef: 're_sf',
        outcome: 'failed',
      }),
    ).toBe('noop');
    expect(a.sink.find('provider_refund_failed_after_success')).toHaveLength(1);
    const [r] = await db`select status from order_refunds where id = 'rf-sf'`;
    expect(r?.['status']).toBe('succeeded');

    // 整单退款：订单已 refunded，退款单号就是落定那笔
    await seedOrder('o-ff', 'refunded');
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-ff', 'refunded', 're_ff', 'admin:u-a', now())`;
    const b = deps();
    expect(
      await applyProviderRefundProgress(b.d, {
        orderId: 'o-ff',
        channel: 'stripe',
        refundRef: 're_ff',
        outcome: 'failed',
      }),
    ).toBe('noop');
    expect(b.sink.find('provider_refund_failed_after_success')).toHaveLength(1);
    expect(await statusOf('o-ff')).toBe('refunded');
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

  it('🔴 迟到付款单的整单退款（支付行不是 succeeded）+ 机构 succeeded → 同样落定 refunded（四天提交复查 2026-10-16）', async () => {
    await seedOrder('o-late', 'refunding');
    // 迟到付款：钱到时订单已关、落账回滚——支付行停在 initiated、paid_at 为空，只有 late_paid 凭据
    await db`update orders set paid_at = null where id = 'o-late'`;
    await db`update payments set status = 'initiated' where id = 'pay-o-late'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-late', 'late_paid', 'cs_o-late', 'provider:stripe', now()),
                    ('o-late', 'refunding', '迟到付款退回', 'admin:u-a', now()),
                    ('o-late', 'refund_pending', 're_late', 'admin:u-a', now())`;
    const out = await applyProviderRefundProgress(deps().d, {
      orderId: 'o-late',
      channel: 'stripe',
      refundRef: 're_late',
      outcome: 'succeeded',
    });
    expect(out).toBe('full');
    expect(await statusOf('o-late')).toBe('refunded');
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

describe('settleFullRefundFromProvider：三个"对不上就 noop"的幂等分支（直测函数体，非上层提前返回）', () => {
  /**
   * @why 上面的用例走 `applyProviderRefundProgress`，pending / 对不上是在**上层**（listPartialRefunds
   *      之前、第 37 行的 `outcome === 'pending'`、第 42 行的部分退款行已落定）就 return 了，
   *      `settleFullRefundFromProvider` 函数体内部的三处 noop 分支（L219 / L223 / L236）一行都没执行到。
   *      它们各自是一个**真实防御分支**——机构回调推进整单退款时，任何"对不上"都该静默跳过，
   *      不能猜、不能动钱（文件头 @why：回调可能晚于管理员手动同步，也可能是我们不认识的退款）。
   */
  it('机构报 pending（在途）→ noop：整单退款回调不处理"在途"，等下一条进展', async () => {
    await seedOrder('o-sp-pd', 'refunding');
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-sp-pd', 'refund_pending', 're_sp_pd', 'admin:u-a', now())`;
    const out = await settleFullRefundFromProvider(deps().d, {
      orderId: 'o-sp-pd',
      refundRef: 're_sp_pd',
      outcome: 'pending',
      actor: 'provider:stripe',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-sp-pd')).toBe('refunding'); // 状态不动
  });

  it('订单不在 refunding（如已被管理员手动同步成 refunded）→ noop，不动已落定的单', async () => {
    await seedOrder('o-sp-paid', 'paid');
    const out = await settleFullRefundFromProvider(deps().d, {
      orderId: 'o-sp-paid',
      refundRef: 're_sp_paid',
      outcome: 'succeeded',
      actor: 'provider:stripe',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-sp-paid')).toBe('paid');
  });

  it('订单在 refunding、单号匹配，但**没有可退的支付行**（pay 为 null）→ noop，不落账', async () => {
    // seedOrder 已插了一笔 succeeded 支付行；删掉它制造"找不到 succeeded 支付行"的真实形态
    // （例：迟到付款的单没有封口支付行，见 orders-admin.ts findRefundablePayment 的 @why）
    await seedOrder('o-sp-nopay', 'refunding');
    await db`delete from payments where order_id = 'o-sp-nopay'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-sp-nopay', 'refunding', '买家取消', 'admin:u-a', now()),
                    ('o-sp-nopay', 'refund_pending', 're_sp_nopay', 'admin:u-a', now())`;
    const out = await settleFullRefundFromProvider(deps().d, {
      orderId: 'o-sp-nopay',
      refundRef: 're_sp_nopay',
      outcome: 'succeeded',
      actor: 'provider:stripe',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-sp-nopay')).toBe('refunding');
  });

  it('订单在 refunding、单号匹配、有支付行，但**没有 refunding 事件**（reason 为 null）→ noop，不落账', async () => {
    await seedOrder('o-sp-noreason', 'refunding');
    // 只有 refund_pending 事件，缺 refunding 事件 → findRefundingReason 返回 null
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-sp-noreason', 'refund_pending', 're_sp_noreason', 'admin:u-a', now())`;
    const out = await settleFullRefundFromProvider(deps().d, {
      orderId: 'o-sp-noreason',
      refundRef: 're_sp_noreason',
      outcome: 'succeeded',
      actor: 'provider:stripe',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-sp-noreason')).toBe('refunding');
  });

  it('机构报的单号与订单"在途那笔"对不上 → noop（不猜：可能是迟到回调或我们不认识的退款）', async () => {
    await seedOrder('o-sp-mismatch', 'refunding');
    // 在途单号是 re_expected，机构报的是 re_other —— 对不上就跳过，不动钱
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-sp-mismatch', 'refunding', '买家取消', 'admin:u-a', now()),
                    ('o-sp-mismatch', 'refund_pending', 're_expected', 'admin:u-a', now())`;
    const out = await settleFullRefundFromProvider(deps().d, {
      orderId: 'o-sp-mismatch',
      refundRef: 're_other',
      outcome: 'succeeded',
      actor: 'provider:stripe',
    });
    expect(out).toBe('noop');
    expect(await statusOf('o-sp-mismatch')).toBe('refunding');
  });
});
