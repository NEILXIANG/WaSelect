/**
 * 运营可见性（AJ-425，统一结论 5.1 / U10"有人负责却没人看得到"）：`GET /admin/orders?attention=…` 三类待处理 +
 * 列表行的 `after_sale_open` / `user_blocked` 标记。真实路由 + 真实 Postgres。
 *
 * @why 每类都种"该进的"与"看起来像但不该进的"：只种该进的，筛选写宽（例如售后不看状态、拉黑不看订单状态）也是绿的。
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
const JWT_SECRET = 'admin-order-attention-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void> };
let admin: string;

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid, email, is_admin) values ('u-admin', 'o-admin', 'ops@example.com', true)`;
  await db`insert into users (id, openid) values ('u-a', 'o-a')`;
  await db`insert into users (id, openid, blocked_at) values ('u-b', 'o-b', now())`;
  admin = await signToken(
    { sub: 'u-admin', role: 'admin' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
  const logger = createLogger({ env: 'test', destination: new MemorySink() });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-attention-test',
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
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close };
  return async () => {
    await srv.close();
  };
});

async function order(id: string, status: string, userId = 'u-a'): Promise<void> {
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at)
    values (${id}, ${`W-${id}`}, ${userId}, ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() - interval '1 day')`;
}
async function afterSale(orderId: string, status: string): Promise<void> {
  await db`
    insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
    values (${`as-${orderId}`}, ${orderId}, 'u-a', 'damaged', '罐子凹了', ${status}, now(), now())`;
}
async function latePaid(orderId: string): Promise<void> {
  await db`insert into order_events (order_id, status, note, actor, at)
           values (${orderId}, 'late_paid', 'evt-late', 'provider:mock', now())`;
}

async function seedAll(): Promise<void> {
  await order('o-as-open', 'delivered');
  await afterSale('o-as-open', 'open');
  await order('o-as-done', 'delivered');
  await afterSale('o-as-done', 'resolved');
  await order('o-late', 'expired');
  await latePaid('o-late');
  await order('o-late-done', 'refunded');
  await latePaid('o-late-done');
  // 独立排查 2026-10-14 C-6：迟到付款但拒付已败诉（银行已把钱退回买家）——不该再提醒去退
  await order('o-late-lost', 'expired');
  await latePaid('o-late-lost');
  await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount, dispute_id, dispute_status, dispute_amount)
           values ('pay-late-lost', 'o-late-lost', 'stripe', 'succeeded', 'USD', 8600, 'dp_1', 'lost', 8600)`;
  await order('o-blk-paid', 'paid', 'u-b');
  await order('o-blk-ship', 'shipped', 'u-b');
  await order('o-plain', 'paid');
}

async function list(qs: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}/api/v1/admin/orders?${qs}`, {
    headers: { authorization: `Bearer ${admin}` },
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
const ids = (r: { json: Record<string, unknown> }): string[] =>
  (r.json['items'] as Array<{ order_id: string }>).map((o) => o.order_id).sort();

describe('GET /admin/orders?attention=…（AJ-425）', () => {
  it('🔴 after_sale：只含有进行中售后（open / processing）的单，已结案的不进', async () => {
    await seedAll();
    const r = await list('attention=after_sale');
    expect([r.status, ids(r), r.json['total']]).toEqual([200, ['o-as-open'], 1]);
  });

  it('🔴 late_paid：只含有迟到付款凭据且尚未退款 / 退款中的单；拒付已败诉的不进（C-6）', async () => {
    await seedAll();
    expect(ids(await list('attention=late_paid'))).toEqual(['o-late']);
  });

  it('🔴 blocked：只含被拉黑用户的已付款未发货单（已发货的不进，别的用户的已付单不进）', async () => {
    await seedAll();
    expect(ids(await list('attention=blocked'))).toEqual(['o-blk-paid']);
  });

  it('与 status 同时给 = 两个条件都要满足；非法取值 → 400 / 40001 attention_invalid', async () => {
    await seedAll();
    expect(ids(await list('attention=blocked&status=shipped'))).toEqual([]);
    const bad = await list('attention=everything');
    expect([bad.status, bad.json['code']]).toEqual([400, 40001]);
  });

  it('🔴 列表行带 after_sale_open / user_blocked（不筛选时也带，运营在列表里一眼看见）', async () => {
    await seedAll();
    const r = await list('size=50');
    const row = (id: string) =>
      (r.json['items'] as Array<Record<string, unknown>>).find((o) => o['order_id'] === id);
    expect([row('o-as-open')?.['after_sale_open'], row('o-as-open')?.['user_blocked']]).toEqual([
      true,
      false,
    ]);
    expect([row('o-as-done')?.['after_sale_open'], row('o-blk-paid')?.['user_blocked']]).toEqual([
      false,
      true,
    ]);
    expect([row('o-plain')?.['after_sale_open'], row('o-plain')?.['user_blocked']]).toEqual([
      false,
      false,
    ]);
  });
});
