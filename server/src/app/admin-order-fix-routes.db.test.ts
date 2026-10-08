/**
 * 管理端"手滑出口"两条路由（第三轮缺口 P1-11 / P1-10，AJ-386）：真实路由 + 真实 Postgres + mock 通道。
 *
 * @why 运营最常见的两种手滑原先都没有出口：价格录错后的**未付**单只能等过期或拉黑买家（副作用过大）；
 *      运单号填错后只能改库（且错号已随邮件发出）。
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
const JWT_SECRET = 'admin-order-fix-route-test-jwt-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

let srv: { url: string; close: () => Promise<void>; sink: MemorySink };
let token: string;
let published: string[];

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
    MOCK_CALLBACK_SECRET: 'mock-secret-for-admin-order-fix-test',
    TERMS_VERSION: 'TOS-TEST-1',
  });
  const events = createEventBus(logger);
  published = [];
  for (const n of ['order.cancelled', 'order.shipped']) {
    events.subscribe(n, (e) => {
      published.push(`${e.name}:${String(e.payload?.['mail_key'] ?? '')}`);
    });
  }
  const app = createHttpApp({
    logger,
    mount: (a) => mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() }),
  });
  const s = await listen(app);
  srv = { url: `http://127.0.0.1:${String(s.port)}`, close: s.close, sink };
  return async () => {
    await srv.close();
  };
});

async function seed(
  id: string,
  status: string,
  extra: { carrier?: string; tracking?: string } = {},
): Promise<void> {
  await db`insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`}) on conflict do nothing`;
  await db`insert into products (id, title, category, price_jpy, weight_g, stock, origin_country)
           values (${`p-${id}`}, '抹茶粉', 'food', 5000, 400, 3, 'JP') on conflict do nothing`;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy, weight_g,
                        fx_snapshot, address_snapshot, terms_version, expires_at, carrier, tracking_no, shipped_at)
    values (${id}, ${`W-${id}`}, ${`u-${id}`}, ${status}, 10000, 2000, 1500, 12000, 900, ${db.json({ USD: 0.0068 })},
            ${db.json({ recipient: 'Jane Doe', phone: '+14155550123', line1: '1 Main St', city: 'Cupertino', state: 'CA', postal_code: '95014', country: 'US' })},
            'TOS-2026-09-20', now() + interval '30 minutes', ${extra.carrier ?? null}, ${extra.tracking ?? null},
            ${status === 'shipped' ? new Date() : null})
  `;
  await db`insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd)
           values (${`oi-${id}`}, ${id}, ${`p-${id}`}, '抹茶粉', 2, 5000, 400, 3400)`;
}

async function post(
  path: string,
  body: unknown,
  method = 'POST',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${srv.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('POST /admin/orders/:id/cancel（P1-11）', () => {
  it('🔴 未付单 → cancelled、库存回补、事件 actor=admin 且带原因、发 order.cancelled、写审计', async () => {
    await seed('o-c1', 'created');
    const r = await post('/api/v1/admin/orders/o-c1/cancel', {
      reason: '价格录错，联系买家重新下单',
    });
    expect(r.status).toBe(200);
    const [o] = await db`select status from orders where id = 'o-c1'`;
    expect(o?.['status']).toBe('cancelled');
    const [p] = await db`select stock from products where id = 'p-o-c1'`;
    expect(p?.['stock']).toBe(5);
    const [ev] =
      await db`select actor, note from order_events where order_id = 'o-c1' and status = 'cancelled'`;
    expect(ev).toMatchObject({ actor: 'admin:u-admin', note: '价格录错，联系买家重新下单' });
    expect(published).toContain('order.cancelled:');
    // 审计写在响应之后（admin-audit.ts @limitation：客户端拿到 200 时不保证已落库）——
    // 全量 gate 负载下立即读曾读到空（2026-10-08 实测一次红），轮询等它落库
    let audit: readonly Record<string, unknown>[] = [];
    for (let i = 0; i < 50 && audit.length === 0; i++) {
      audit = await db`select action from admin_audit where target = 'o-c1'`;
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit.map((a) => String(a['action']))).toEqual(['POST /admin/orders/:id/cancel']);
  });

  it('🔴 已付单 → 40902（钱已收的单要走退款，不能取消）；原因为空 → 40001；不存在 → 40400', async () => {
    await seed('o-c2', 'paid');
    expect((await post('/api/v1/admin/orders/o-c2/cancel', { reason: 'x' })).json['code']).toBe(
      40902,
    );
    await seed('o-c3', 'pending_payment');
    expect((await post('/api/v1/admin/orders/o-c3/cancel', { reason: ' ' })).json['code']).toBe(
      40001,
    );
    expect((await post('/api/v1/admin/orders/o-none/cancel', { reason: 'x' })).json['code']).toBe(
      40400,
    );
  });
});

describe('PATCH /admin/orders/:id/shipment（P1-10）', () => {
  it('🔴 已发货单改运单号 → 更新、事件记旧→新、重发发货邮件（独立幂等键）、返回 tracking_recognized', async () => {
    await seed('o-s1', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JX' });
    const r = await post(
      '/api/v1/admin/orders/o-s1/shipment',
      { carrier: 'EMS', tracking_no: 'EE123456789JP', reason: '运单号少打一位' },
      'PATCH',
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      carrier: 'EMS',
      tracking_no: 'EE123456789JP',
      tracking_recognized: true,
    });
    const [o] = await db`select tracking_no from orders where id = 'o-s1'`;
    expect(o?.['tracking_no']).toBe('EE123456789JP');
    const [ev] =
      await db`select note from order_events where order_id = 'o-s1' and status = 'shipment_fixed'`;
    expect(String(ev?.['note'])).toContain('EE123456789JX');
    expect(published.filter((p) => p.startsWith('order.shipped:fix-'))).toHaveLength(1);
  });

  it('🔴 未发货 / 已签收 → 40902；原因为空 → 40001；运单号超长 → 40001', async () => {
    await seed('o-s2', 'paid');
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s2/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40902);
    await seed('o-s3', 'delivered', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s3/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40902);
    await seed('o-s4', 'shipped', { carrier: 'EMS', tracking: 'EE123456789JP' });
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s4/shipment',
          { carrier: 'EMS', tracking_no: 'EE1JP', reason: ' ' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40001);
    expect(
      (
        await post(
          '/api/v1/admin/orders/o-s4/shipment',
          { carrier: 'EMS', tracking_no: 'x'.repeat(65), reason: 'x' },
          'PATCH',
        )
      ).json['code'],
    ).toBe(40001);
  });

  it('首次发货也返回 tracking_recognized（形状认不出时 false，供管理端提示核对，不拦）', async () => {
    await seed('o-s5', 'paid');
    const r = await post('/api/v1/admin/orders/o-s5/ship', {
      carrier: 'EMS',
      tracking_no: '=HYPERLINK("x")',
    });
    expect(r.status).toBe(200);
    expect(r.json['tracking_recognized']).toBe(false);
  });
});
