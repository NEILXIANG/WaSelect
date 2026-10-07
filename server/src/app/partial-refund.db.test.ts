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
import {
  insertPartialRefund,
  listPartialRefunds,
  settlePartialRefund,
} from '../adapters/order-refunds.js';
import { CircuitOpenError } from '../ports/circuit-breaker.js';
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
  d: { db: Db; logger: ReturnType<typeof createLogger>; clock: typeof CLOCK };
  sink: MemorySink;
} {
  const sink = new MemorySink();
  return {
    d: { db, logger: createLogger({ env: 'test', destination: sink }), clock: CLOCK },
    sink,
  };
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
