/**
 * 部分退款**执行段**（调机构 → 按结果落账）的分支表（AJ-383）。真实 Postgres + 假通道。
 *
 * @why 每个分支都是钱的口径：成功要落账并留事件；在途要记单号；确认失败要释放额度；
 *      结果未知**不能**当失败（钱可能已经退了），也不能换键重发（会退两次）——只能同键重放。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../test/helpers/fixed-clock.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { closeDb, type Db } from '../adapters/db.js';
import { createLogger } from '../logger.js';
import { createEventBus } from '../adapters/event-bus.js';
import {
  insertPartialRefund,
  listPartialRefunds,
  settlePartialRefund,
} from '../adapters/order-refunds.js';
import { CircuitOpenError } from '../ports/circuit-breaker.js';
import { shipGuard } from '../domain/admin-order-actions.js';
import { asOrderStatus } from '../domain/order.js';
import type { PaymentProvider, RefundRequest, RefundResult } from '../ports/payment.js';
import {
  executePartialRefund,
  syncPartialRefund,
  type PartialRefundPlan,
} from './partial-refund.js';

let db: Db;
const CLOCK = fixedClock('2026-10-06T12:00:00.000Z');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-p', 'o-p')`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
    values ('o-p', 'W-P', 'u-p', 'delivered', 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now())
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values ('pay-p', 'o-p', 'stripe', 'cs_test_p', 'succeeded', 'USD', 8160)
  `;
  await insertPartialRefund(db, {
    id: 'rf-1',
    orderId: 'o-p',
    paymentId: 'pay-p',
    currency: 'USD',
    amountMinor: 1000,
    reason: '缺一件：抹茶粉',
    actor: 'admin:u-admin',
  });
});

const PLAN: PartialRefundPlan = {
  refundId: 'rf-1',
  orderId: 'o-p',
  channel: 'stripe',
  providerRef: 'cs_test_p',
  currency: 'USD',
  amountMinor: 1000,
  reason: '缺一件：抹茶粉',
  actor: 'admin:u-admin',
};

function deps(): {
  d: {
    db: Db;
    logger: ReturnType<typeof createLogger>;
    clock: typeof CLOCK;
    events: ReturnType<typeof createEventBus>;
  };
  sink: MemorySink;
  published: Array<{ name: string; payload?: Record<string, unknown> | undefined }>;
} {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const events = createEventBus(logger);
  const published: Array<{ name: string; payload?: Record<string, unknown> | undefined }> = [];
  for (const n of ['order.partially_refunded', 'order.refunded']) {
    events.subscribe(n, (e) => {
      published.push({ name: e.name, payload: e.payload });
    });
  }
  return { d: { db, logger, clock: CLOCK, events }, sink, published };
}

/** 假通道：refund 按 `next` 返回或抛；记下每次收到的请求。 */
function fake(next: RefundResult | Error, status: RefundResult['outcome'] = 'succeeded') {
  const calls: RefundRequest[] = [];
  const statusCalls: string[] = [];
  const provider = {
    channel: 'stripe',
    refund: (req: RefundRequest) => {
      calls.push(req);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    refundStatus: (ref: string) => {
      statusCalls.push(ref);
      return Promise.resolve(status);
    },
  } as unknown as PaymentProvider;
  return { provider, calls, statusCalls };
}

const row = async () => (await listPartialRefunds(db, 'o-p'))[0];
const events = async () =>
  (await db`select status, note from order_events where order_id = 'o-p' order by id`).map((e) => [
    e['status'],
    e['note'],
  ]);

describe('executePartialRefund', () => {
  it('成功 → 行 succeeded + 单号 + 事件 partial_refunded；请求带本笔金额与 partialRefundId', async () => {
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'succeeded' });
    expect(await executePartialRefund(deps().d, f.provider, PLAN)).toBe('succeeded');
    expect(f.calls[0]).toMatchObject({
      amountMinor: 1000,
      currency: 'USD',
      partialRefundId: 'rf-1',
    });
    expect(await row()).toMatchObject({ status: 'succeeded', provider_ref: 're_1' });
    expect(await events()).toEqual([['partial_refunded', 'rf-1:USD:1000']]);
  });

  it('在途 → 行 pending + 单号，不写事件', async () => {
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'pending' });
    expect(await executePartialRefund(deps().d, f.provider, PLAN)).toBe('pending');
    expect(await row()).toMatchObject({ status: 'pending', provider_ref: 're_1' });
    expect(await events()).toEqual([]);
  });

  it('🔴 机构确认失败 → 行 failed（释放额度）+ 事件 partial_failed + 抛 50000', async () => {
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'failed' });
    await expect(executePartialRefund(deps().d, f.provider, PLAN)).rejects.toMatchObject({
      code: 50000,
    });
    expect(await row()).toMatchObject({ status: 'failed' });
    expect(await events()).toEqual([['partial_failed', 'rf-1:provider_failed']]);
  });

  it('🔴 结果未知（抛错）→ 行 unknown（仍占额度，不当失败）+ error 日志 + 抛 50000', async () => {
    const { d, sink } = deps();
    const f = fake(new Error('socket hang up'));
    await expect(executePartialRefund(d, f.provider, PLAN)).rejects.toMatchObject({ code: 50000 });
    expect(await row()).toMatchObject({ status: 'unknown' });
    expect(sink.find('admin_partial_refund_unknown')).toHaveLength(1);
  });

  it('🔴 熔断拒绝（一次都没发出去）→ 行 failed 释放额度，原样抛 CircuitOpenError', async () => {
    const f = fake(new CircuitOpenError('stripe', 1500));
    await expect(executePartialRefund(deps().d, f.provider, PLAN)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(await row()).toMatchObject({ status: 'failed' });
  });

  it('🔴 AJ-414 熔断拒绝但第 1 次已发出（attempted）→ 行 unknown（占额度，sync 同键重放），仍原样抛 CircuitOpenError', async () => {
    const { d, sink } = deps();
    const f = fake(new CircuitOpenError('stripe', 1500, true));
    await expect(executePartialRefund(d, f.provider, PLAN)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(await row()).toMatchObject({ status: 'unknown' });
    expect(await events()).toEqual([]);
    expect(sink.find('admin_partial_refund_circuit_open')[0]?.['result']).toBe('unknown');
    // 重试走 sync：同一把键（partialRefundId 不变）重放，而不是建新行
    const g = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'succeeded' });
    await syncPartialRefund(d, g.provider, PLAN);
    expect(g.calls.map((c) => c.partialRefundId)).toEqual(['rf-1']);
    expect(await row()).toMatchObject({ status: 'succeeded' });
  });
});

describe('syncPartialRefund', () => {
  it('pending → 按单号查询；落定 succeeded 写事件', async () => {
    await settlePartialRefund(db, 'rf-1', 'pending', 're_1', CLOCK.now());
    const f = fake(new Error('不该再发起'), 'succeeded');
    expect(await syncPartialRefund(deps().d, f.provider, PLAN)).toBe('succeeded');
    expect(f.statusCalls).toEqual(['re_1']);
    expect(f.calls).toHaveLength(0);
    expect(await events()).toEqual([['partial_refunded', 'rf-1:USD:1000']]);
  });

  it('🔴 unknown → **同一把键**重放（partialRefundId 不变），不换键、不按单号查', async () => {
    await settlePartialRefund(db, 'rf-1', 'unknown', null, CLOCK.now());
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'succeeded' });
    expect(await syncPartialRefund(deps().d, f.provider, PLAN)).toBe('succeeded');
    expect(f.calls.map((c) => c.partialRefundId)).toEqual(['rf-1']);
    expect(f.statusCalls).toHaveLength(0);
  });

  it('已落定（succeeded / failed）→ 不调机构，原样返回', async () => {
    await settlePartialRefund(db, 'rf-1', 'succeeded', 're_1', CLOCK.now());
    const f = fake(new Error('不该调用'));
    expect(await syncPartialRefund(deps().d, f.provider, PLAN)).toBe('succeeded');
    expect(f.calls).toHaveLength(0);
    expect(f.statusCalls).toHaveLength(0);
  });
});

describe('部分退款的买家通知与"退满"收尾（第三轮缺口 P2-1 / P2-12）', () => {
  it('🔴 成功一笔 → 发 order.partially_refunded（payload 带 refund_id），不发整单退款事件', async () => {
    const { d, published } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_1', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, PLAN);
    expect(published).toEqual([
      { name: 'order.partially_refunded', payload: { refund_id: 'rf-1' } },
    ]);
  });

  it('🔴 部分退款累计退满实收（未发货）→ 事件 refunded_by_parts + 回补库存 + 发 order.refunded', async () => {
    await db`insert into products (id, title, category, price_jpy, weight_g, stock, origin_country)
             values ('p-pr', '抹茶粉', 'food', 10000, 400, 5, 'JP')`;
    await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
             values ('oi-pr', 'o-p', 'p-pr', '抹茶粉', 2, 5000, 400, 3400)`;
    await db`update orders set status = 'paid', paid_at = now(), shipped_at = null where id = 'o-p'`;
    await db`update order_refunds set amount_minor = 8160 where id = 'rf-1'`;
    const { d, published } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_full', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 });
    expect(await events()).toContainEqual(['refunded_by_parts', 'USD:8160']);
    const [p] = await db`select stock from products where id = 'p-pr'`;
    expect(p?.['stock']).toBe(7);
    expect(published.map((x) => x.name)).toEqual(['order.refunded']);
    // 🔴 AJ-414：订单沿状态机走到 refunded（refunding → refunded 两条事件），payments 行同步 refunded——
    //    否则这张"钱已全退、库存已回补"的单仍是 paid：发货闸门放行、待采购清单照出
    const [o] = await db`select status, refunded_at from orders where id = 'o-p'`;
    expect(o).toMatchObject({ status: 'refunded' });
    expect(o?.['refunded_at']).not.toBeNull();
    expect((await events()).map((e) => e[0])).toEqual([
      'partial_refunded',
      'refunded_by_parts',
      'refunding',
      'refunded',
    ]);
    const [pay] = await db`select status from payments where order_id = 'o-p'`;
    expect(pay?.['status']).toBe('refunded');
  });

  it('🔴 AJ-414 退满后发货闸门关闭：shipGuard 对 refunded 拒（40902 status_refunded）', async () => {
    await db`update orders set status = 'paid', paid_at = now(), shipped_at = null where id = 'o-p'`;
    await db`update order_refunds set amount_minor = 8160 where id = 'rf-1'`;
    const { d } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_full', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 });
    const [o] = await db`select status, has_dispute, is_test from orders where id = 'o-p'`;
    const gate = shipGuard(
      asOrderStatus(o?.['status']),
      o?.['has_dispute'] === true,
      o?.['is_test'] === true,
    );
    expect(gate).toMatchObject({ ok: false, code: 40902, reason: 'status_refunded' });
  });

  it('🔴 AJ-447 已完成（completed）的单退满 → 同样迁到 refunded（钱已全退，不能继续显示"已完成"）', async () => {
    await db`update orders set status = 'completed', paid_at = now(), shipped_at = now() where id = 'o-p'`;
    await db`update order_refunds set amount_minor = 8160 where id = 'rf-1'`;
    const { d, sink } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_full', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 });
    expect(await events()).toContainEqual(['refunded_by_parts', 'USD:8160']);
    const [o] = await db`select status, refunded_at from orders where id = 'o-p'`;
    expect(o?.['status']).toBe('refunded');
    expect(o?.['refunded_at']).not.toBeNull();
    const [p] = await db`select status from payments where id = 'pay-p'`;
    expect(p?.['status']).toBe('refunded');
    expect((await events()).map((e) => e[0])).toEqual(
      expect.arrayContaining(['refunding', 'refunded']),
    );
    expect(sink.find('admin_partial_refund_fully_refunded')[0]?.['ctx']).toMatchObject({
      status_moved: true,
    });
  });

  it('🔴 S-1（AJ-457）：行已 succeeded 但收尾没做（落定与收尾不是一个事务，中途失败）→ 同步时补做收尾：单迁 refunded、发 order.refunded', async () => {
    // 模拟"落定那一步成功、收尾那一步失败"留下的状态：行 succeeded 且金额已达实收，但没有 refunded_by_parts 事件
    await db`update order_refunds set amount_minor = 8160, status = 'succeeded', provider_ref = 're_x', settled_at = now() where id = 'rf-1'`;
    const { d, published } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_x', outcome: 'succeeded' });
    expect(await syncPartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 })).toBe(
      'succeeded',
    );
    expect(f.calls).toHaveLength(0); // 已落定：不调机构
    const [o] = await db`select status from orders where id = 'o-p'`;
    expect(o?.['status']).toBe('refunded');
    expect(await events()).toContainEqual(['refunded_by_parts', 'USD:8160']);
    expect(published.map((p) => p.name)).toEqual(['order.refunded']);
    // 再同步一次：收尾幂等，不重复发事件
    await syncPartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 });
    expect(published.map((p) => p.name)).toEqual(['order.refunded']);
  });

  it('🔴 AJ-427 累计退满（未发货），其中**更早的一笔**是「缺货」→ 不回补库存；单照常 refunded', async () => {
    await db`insert into products (id, title, category, price_jpy, weight_g, stock, origin_country)
             values ('p-pr', '抹茶粉', 'food', 10000, 400, 5, 'JP')`;
    await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
             values ('oi-pr', 'o-p', 'p-pr', '抹茶粉', 2, 5000, 400, 3400)`;
    await db`update orders set status = 'paid', paid_at = now(), shipped_at = null where id = 'o-p'`;
    await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, settled_at)
             values ('rf-0', 'o-p', 'pay-p', 'USD', 4000, '缺货：抹茶粉', 'succeeded', 'admin:u-admin', now())`;
    await db`update order_refunds set amount_minor = 4160, reason = '破损：外盒压坏' where id = 'rf-1'`;
    const { d } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_full', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, {
      ...PLAN,
      amountMinor: 4160,
      reason: '破损：外盒压坏',
    });
    expect(await events()).toContainEqual(['refunded_by_parts', 'USD:8160']);
    const [p] = await db`select stock from products where id = 'p-pr'`;
    expect(p?.['stock']).toBe(5);
    const [o] = await db`select status from orders where id = 'o-p'`;
    expect(o?.['status']).toBe('refunded');
  });

  it('退满但已发货 → 记事件、不回补库存（货已寄出，退货入库是人工流程）', async () => {
    await db`insert into products (id, title, category, price_jpy, weight_g, stock, origin_country)
             values ('p-pr', '抹茶粉', 'food', 10000, 400, 5, 'JP')`;
    await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
             values ('oi-pr', 'o-p', 'p-pr', '抹茶粉', 2, 5000, 400, 3400)`;
    await db`update orders set paid_at = now(), shipped_at = now() where id = 'o-p'`;
    await db`update order_refunds set amount_minor = 8160 where id = 'rf-1'`;
    const { d } = deps();
    const f = fake({ providerRef: 'cs_test_p', refundRef: 're_full', outcome: 'succeeded' });
    await executePartialRefund(d, f.provider, { ...PLAN, amountMinor: 8160 });
    expect(await events()).toContainEqual(['refunded_by_parts', 'USD:8160']);
    const [p] = await db`select stock from products where id = 'p-pr'`;
    expect(p?.['stock']).toBe(5);
    // AJ-414：已发货的单同样迁到 refunded（shipped → refunding → refunded）
    const [o] = await db`select status from orders where id = 'o-p'`;
    expect(o?.['status']).toBe('refunded');
  });
});
