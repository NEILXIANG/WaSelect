/**
 * 部分退款路由（AJ-383）：真实路由 + 真实 Postgres + mock 通道（mock 退款同步成功）。
 *
 * @why 钉住的是**组合**：额度在锁内求和、与整单退款互斥、订单状态不动、完成后仍能退、整单退款只退余额。
 *      执行段的各结果分支（pending / failed / unknown / 熔断）在 partial-refund.db.test.ts 里逐条钉。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'partial-refund-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let token: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'admin@example.com', true)`;
  token = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-partial-refund-test',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const app = createHttpApp({
    logger,
    mount: (a) =>
      mountAllRoutes(a, {
        config,
        logger,
        db,
        events: createEventBus(logger),
        storage: createMemoryStorage(),
      }),
  });
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

async function seed(id: string, status: string, dispute = false): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at, paid_at, shipped_at, has_dispute)
    values (${id}, ${`W-${id}`}, ${`u-${id}`}, ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now(), now(), now(), ${dispute})
  `;
  await db`
    insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount)
    values (${`pay-${id}`}, ${id}, 'mock', ${`mock_${id}`}, 'succeeded', 'JPY', 12000)
  `;
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

const partial = (id: string, amount: number) =>
  post(`/api/v1/admin/orders/${id}/partial-refunds`, {
    amount_minor: amount,
    reason: '缺一件：抹茶粉',
  });

describe('POST /admin/orders/:id/partial-refunds', () => {
  it('已签收的单退 3000 → 202 succeeded；订单状态不变；行与事件都在', async () => {
    await seed('o-1', 'delivered');
    const r = await partial('o-1', 3000);
    expect(r.status).toBe(202);
    expect(r.json['refund']).toMatchObject({
      status: 'succeeded',
      amount_minor: 3000,
      currency: 'JPY',
    });
    const [o] = await db`select status from orders where id = 'o-1'`;
    expect(o?.['status']).toBe('delivered');
    const ev = await db`select status from order_events where order_id = 'o-1'`;
    expect(ev.map((e) => e['status'])).toContain('partial_refunded');
  });

  it('🔴 订单已完成（completed）→ 仍可部分退款（售后出口）', async () => {
    await seed('o-2', 'completed');
    expect((await partial('o-2', 1000)).status).toBe(202);
  });

  it('🔴 超出可退额度 → 40001（已退 9000，再退 3001）', async () => {
    await seed('o-3', 'shipped');
    expect((await partial('o-3', 9000)).status).toBe(202);
    const r = await partial('o-3', 3001);
    expect(r.json['code']).toBe(40001);
    expect(await partial('o-3', 3000)).toMatchObject({ status: 202 });
  });

  it('🔴 拒付进行中 → 40907；整单退款中 → 40902', async () => {
    await seed('o-4', 'paid', true);
    expect((await partial('o-4', 100)).json['code']).toBe(40907);
    await seed('o-5', 'refunding');
    expect((await partial('o-5', 100)).json['code']).toBe(40902);
  });

  it('🔴 理由为空 → 40001，且不登记任何一行', async () => {
    await seed('o-6', 'paid');
    const r = await post('/api/v1/admin/orders/o-6/partial-refunds', {
      amount_minor: 100,
      reason: '  ',
    });
    expect(r.json['code']).toBe(40001);
    expect(await db`select 1 from order_refunds where order_id = 'o-6'`).toHaveLength(0);
  });
});

describe('与整单退款互斥 / 整单退款只退余额', () => {
  it('🔴 有一笔部分退款在途（pending）→ 整单退款 40902 partial_refund_in_flight', async () => {
    await seed('o-7', 'paid');
    await db`
      insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, provider_ref, actor)
      values ('rf-p', 'o-7', 'pay-o-7', 'JPY', 1000, 'x', 'pending', 'mock_rf_p', 'admin:u-admin')
    `;
    const r = await post('/api/v1/admin/orders/o-7/refund', { reason: '整单退' });
    expect(r.json['code']).toBe(40902);
    const [o] = await db`select status from orders where id = 'o-7'`;
    expect(o?.['status']).toBe('paid');
  });

  it('🔴 先部分退 4000，再整单退款 → 机构收到的金额是余额 8000，订单 refunded', async () => {
    await seed('o-8', 'paid');
    expect((await partial('o-8', 4000)).status).toBe(202);
    const r = await post('/api/v1/admin/orders/o-8/refund', { reason: '整单退' });
    expect(r.status).toBe(202);
    const log = srv.sink.find('admin_order_refund_accepted').at(-1);
    expect((log?.['ctx'] as Record<string, unknown>)['amount_minor']).toBe(8000);
    const [o] = await db`select status from orders where id = 'o-8'`;
    expect(o?.['status']).toBe('refunded');
  });

  it('🔴 部分退款已退光 → 整单退款 40902（没有余额可退，不能退 0）', async () => {
    await seed('o-9', 'paid');
    expect((await partial('o-9', 12000)).status).toBe(202);
    const r = await post('/api/v1/admin/orders/o-9/refund', { reason: '整单退' });
    expect(r.json['code']).toBe(40902);
  });
});

// AJ-516：拒付已败诉（银行已把 5000 退回买家）后被人工解除限制（has_dispute=false）——
// 原先两条退款路都只看 has_dispute，解除后整单退款会把 12000 全退（买家拿两次 5000），部分退款额度也按 12000 算。
async function seedLostAfterRelease(id: string, lostMinor: number): Promise<void> {
  await seed(id, 'delivered');
  await db`
    update payments set dispute_id = ${`dp_${id}`}, dispute_status = 'lost', dispute_amount = ${lostMinor},
                        dispute_opened_at = now() - interval '40 days', dispute_closed_at = now()
     where id = ${`pay-${id}`}
  `;
}

describe('拒付已败诉、人工解除限制之后（AJ-516）', () => {
  it('🔴 整单退款 → 40907，data.reason = dispute_lost；订单不动、不写 refunding 事件', async () => {
    await seedLostAfterRelease('o-l1', 5000);
    const r = await post('/api/v1/admin/orders/o-l1/refund', { reason: '买家要求退款' });
    expect(r.json['code']).toBe(40907);
    expect(r.json['data']).toMatchObject({ reason: 'dispute_lost' });
    const [o] = await db`select status from orders where id = 'o-l1'`;
    expect(o?.['status']).toBe('delivered');
    const ev =
      await db`select 1 from order_events where order_id = 'o-l1' and status = 'refunding'`;
    expect(ev.length).toBe(0);
  });

  it('🔴 部分退款额度扣掉败诉金额：12000 − 5000 = 7000；7001 → 40001，7000 → 202', async () => {
    await seedLostAfterRelease('o-l2', 5000);
    expect((await partial('o-l2', 7001)).json['code']).toBe(40001);
    expect(await partial('o-l2', 7000)).toMatchObject({ status: 202 });
  });

  it('详情的支付行带出 lost_dispute_amount（后台据此算可退额度）；没有败诉的行不带', async () => {
    await seedLostAfterRelease('o-l3', 5000);
    await seed('o-l4', 'delivered');
    const get = async (id: string) =>
      (await (
        await fetch(`${srv.url}/api/v1/admin/orders/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { payments: Record<string, unknown>[] };
    expect((await get('o-l3')).payments[0]).toMatchObject({ lost_dispute_amount: 5000 });
    expect((await get('o-l4')).payments[0]).not.toHaveProperty('lost_dispute_amount');
  });
});

describe('POST /admin/orders/:id/partial-refunds/:refundId/sync', () => {
  it('结果未知（unknown）的一笔 → 同步后 succeeded', async () => {
    await seed('o-10', 'paid');
    await db`
      insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor)
      values ('rf-u', 'o-10', 'pay-o-10', 'JPY', 500, 'x', 'unknown', 'admin:u-admin')
    `;
    const r = await post('/api/v1/admin/orders/o-10/partial-refunds/rf-u/sync', {});
    expect(r.status).toBe(200);
    expect(r.json['refund']).toMatchObject({ id: 'rf-u', status: 'succeeded' });
  });

  it('别的订单的退款 id → 40400', async () => {
    await seed('o-11', 'paid');
    const r = await post('/api/v1/admin/orders/o-11/partial-refunds/rf-nope/sync', {});
    expect(r.json['code']).toBe(40400);
  });
});

describe('GET /admin/orders/:id 带出 partial_refunds', () => {
  it('详情里按发起顺序列出部分退款', async () => {
    await seed('o-12', 'paid');
    await partial('o-12', 100);
    const r = await fetch(`${srv.url}/api/v1/admin/orders/o-12`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await r.json()) as Record<string, unknown>;
    expect(json['partial_refunds']).toEqual([
      expect.objectContaining({
        amount_minor: 100,
        currency: 'JPY',
        status: 'succeeded',
        reason: '缺一件：抹茶粉',
      }),
    ]);
  });
});

// 审计 PAY-09（2026-10-14）：退款中（refunding）的单拒付败诉后再点退款，发给机构的金额要扣掉败诉金额
describe('refunding + 拒付已败诉 → 整单退款重试金额扣除败诉金额', () => {
  it('🔴 实收 12000、败诉 5000 → 重试发起 7000', async () => {
    await seedLostAfterRelease('o-l9', 5000);
    await db`update orders set status = 'refunding' where id = 'o-l9'`;
    await db`insert into order_events (order_id, status, note, actor, at)
             values ('o-l9', 'refunding', '买家要求退款', 'admin:u-a', now())`;
    const r = await post('/api/v1/admin/orders/o-l9/refund', { reason: '买家要求退款' });
    expect(r.status).toBe(202);
    const log = srv.sink.find('admin_order_refund_accepted').at(-1);
    expect((log?.['ctx'] as Record<string, unknown>)['amount_minor']).toBe(7000);
  });
});

// 审计 PAY-07（2026-10-14）：拒付仍在进行中（dispute_status = open）、限制被人工解除（has_dispute = false）后，
// 原先整单 / 部分退款都放行——银行随后判买家胜诉时钱再被拉回一次，钱出去两次。
describe('拒付仍在进行中、人工解除限制之后：退款仍拒', () => {
  async function seedOpenAfterRelease(id: string): Promise<void> {
    await seed(id, 'delivered');
    await db`
      update payments set dispute_id = ${`dp_${id}`}, dispute_status = 'open', dispute_amount = 12000,
                          dispute_opened_at = now() - interval '2 days'
       where id = ${`pay-${id}`}
    `;
  }
  it('🔴 整单退款 → 40907，data.reason = dispute_open_released；订单不动', async () => {
    await seedOpenAfterRelease('o-op1');
    const r = await post('/api/v1/admin/orders/o-op1/refund', { reason: '买家要求退款' });
    expect(r.json['code']).toBe(40907);
    expect(r.json['data']).toMatchObject({ reason: 'dispute_open_released' });
    const [o] = await db`select status from orders where id = 'o-op1'`;
    expect(o?.['status']).toBe('delivered');
  });
  it('🔴 部分退款 → 40907', async () => {
    await seedOpenAfterRelease('o-op2');
    expect((await partial('o-op2', 1000)).json['code']).toBe(40907);
  });
});
