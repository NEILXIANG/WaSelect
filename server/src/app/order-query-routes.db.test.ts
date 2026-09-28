/**
 * 职责：订单读路径的接线级真库用例（I1-U5c）——`GET /orders`（status 过滤/归属）与
 *      `GET /orders/{id}`（全形状/40400）。
 *
 * @why 造单走**真实建单端点**而不是裸 SQL 插行：列表/详情展示的字段（fx_snapshot、
 *      address_snapshot、order_events）都是建单链路产出的，手写插行容易造出
 *      "真链路永远不会产生"的形状（假数据要像真的）。
 *
 * @why display 断言独立复算（toMinor + 快照汇率），不从响应抄数——
 *      "用快照汇率"与"用当日汇率"在数值上此刻相等（同一天），但语义不同；
 *      断言钉的是"响应值 === 按快照复算值"，哪天有人改成查当日汇率，语义漂移不红——
 *      所以另有一条把 fx_rates 当日行删掉仍要能读的用例（读路径不依赖当日汇率）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toMinor, toRateInt, applyRate, toRatioInt } from '@waselect/shared';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { SignJWT } from 'jose';
import { AUDIENCE, signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'order-query-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
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
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, close: server.close };
}

let token = '';
let token2 = '';

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1'), ('u-2', 'o-2')`;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, images)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active',
            ${db.json(['https://img.example.com/knife.jpg'])}),
           ('p-cup', 'Tea Cup', 'kitchen', 3200, 480, 10, 'JP', 'active', '[]'::jsonb)
  `;
  for (const s of makeShippingRates('placeholder')) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 hour'),
           ('CNY', 0.049, 0.048, 0.03, now() - interval '1 hour')
  `;
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country, is_default)
    values ('addr-1', 'u-1', 'Jane Doe', '+14155550123', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'US', true)
  `;
  token = await signToken({ sub: 'u-1', role: 'user' }, { secret: JWT_SECRET, issuer: 'waselect' });
  token2 = await signToken(
    { sub: 'u-2', role: 'user' },
    { secret: JWT_SECRET, issuer: 'waselect' },
  );
});

const BODY = {
  items: [
    { product_id: 'p-knife', qty: 1 },
    { product_id: 'p-cup', qty: 2 },
  ],
  address_id: 'addr-1',
  terms_version: 'TOS-TEST-1',
};
const TOTAL = 8800 + 3200 * 2 + 4950; // 15200 + 4950 档 = 20150

async function createOrder(url: string, key: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
    },
    body: JSON.stringify(BODY),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { order_id: string };
  return json.order_id;
}

async function get(
  url: string,
  path: string,
  auth: string = token,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${auth}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /orders（我的订单列表）', () => {
  it('列出本人的单（最新在前），display 按订单自己的 fx_snapshot 复算', async () => {
    const srv = await buildServer();
    try {
      const first = await createOrder(srv.url, 'q1');
      const second = await createOrder(srv.url, 'q2');
      const r = await get(srv.url, '/api/v1/orders');
      expect(r.status).toBe(200);
      const items = r.json['items'] as Array<Record<string, unknown>>;
      expect(items.map((i) => i['order_id'])).toEqual([second, first]);
      const summary = items[0];
      expect(summary?.['order_no']).toMatch(/^\d{6}-[0-9A-Z]{6}$/); // YYMMDD-Crockford6（buildOrderNo）
      expect(summary?.['total_jpy']).toBe(TOTAL);
      expect(summary?.['status']).toBe('created');
      // display 独立复算：快照汇率 USD 0.0067 / CNY 0.049（建单时刻落库的那两个值）
      expect(summary?.['display']).toEqual({
        USD: toMinor(TOTAL, toRateInt('0.0067')),
        CNY: toMinor(TOTAL, toRateInt('0.049')),
      });
    } finally {
      await srv.close();
    }
  });

  it('status 过滤：匹配态留、其余滤掉；非法值 40001；他人列表为空（不泄露存在性）', async () => {
    const srv = await buildServer();
    try {
      await createOrder(srv.url, 'q1');
      const paid = await get(srv.url, '/api/v1/orders?status=paid');
      expect((paid.json['items'] as unknown[]).length).toBe(0);
      const created = await get(srv.url, '/api/v1/orders?status=created');
      expect((created.json['items'] as unknown[]).length).toBe(1);

      const bogus = await get(srv.url, '/api/v1/orders?status=unpaid'); // 旧五值词已废（契约 0.5.5）
      expect(bogus.json['code']).toBe(40001);

      const others = await get(srv.url, '/api/v1/orders', token2);
      expect((others.json['items'] as unknown[]).length).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('读路径不依赖当日汇率：删掉 fx_rates 当日行后列表/详情仍可读（展示价走快照）', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      await db`delete from fx_rates`;
      const list = await get(srv.url, '/api/v1/orders');
      expect(list.status).toBe(200);
      const detail = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(detail.status).toBe(200);
      expect((detail.json['display'] as Record<string, number>)['USD']).toBe(
        toMinor(TOTAL, toRateInt('0.0067')),
      );
    } finally {
      await srv.close();
    }
  });
});

describe('GET /orders/{id}（订单详情）', () => {
  it('全形状：items（图取商品现图）/address/timeline/金额段；无支付行时省略 payment', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.status).toBe(200);
      expect(r.json['terms_version']).toBe('TOS-TEST-1');
      expect(r.json['items_jpy']).toBe(15_200);
      expect(r.json['shipping_jpy']).toBe(4950);
      expect(r.json['duty_jpy']).toBe(applyRate(15_200, toRatioInt('0.15'))); // duty_rates 有 ('JP','US',0.15) 种子行（配置表不被 reset），独立复算

      const items = r.json['items'] as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const knife = items.find((i) => i['product_id'] === 'p-knife');
      expect(knife?.['title']).toBe('Chef Knife');
      expect(knife?.['image']).toEqual({
        thumb: 'https://img.example.com/knife.jpg',
        card: 'https://img.example.com/knife.jpg',
        detail: 'https://img.example.com/knife.jpg',
      });
      const cup = items.find((i) => i['product_id'] === 'p-cup');
      expect(cup?.['image']).toBeUndefined(); // 无图商品省略 image 字段（U5a 同口径）

      const address = r.json['address'] as Record<string, unknown>;
      expect(address['recipient']).toBe('Jane Doe');
      expect(address['postal_code']).toBe('95014');

      const timeline = r.json['timeline'] as Array<Record<string, unknown>>;
      expect(timeline.map((t) => t['status'])).toEqual(['created']);
      expect(r.json['payment']).toBeUndefined(); // 无支付行：省略不编
    } finally {
      await srv.close();
    }
  });

  it('有支付行时 payment 带出（provider → 契约 channel）；他人单与不存在同 40400', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      await db`
        insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
        values ('pay-1', ${orderId}, 'mock', 'initiated', 'JPY', ${TOTAL})
      `;
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.json['payment']).toMatchObject({
        channel: 'mock',
        charge_currency: 'JPY',
        charge_amount: TOTAL,
      });

      const others = await get(srv.url, `/api/v1/orders/${orderId}`, token2);
      expect(others.json['code']).toBe(40400);
      const ghost = await get(srv.url, '/api/v1/orders/ord-ghost');
      expect(ghost.json['code']).toBe(40400);
    } finally {
      await srv.close();
    }
  });
});

describe('鉴权策略的真路由级接线（三审 S3 / U23；骨架退役时从 skeleton.e2e 迁来）', () => {
  it('同密钥同签发者的"无 exp"与 HS512 令牌，走真路由都是 40101（策略层真的接进了路由）', async () => {
    // @why auth.unit.test 钉的是 verifyToken 本身；这里证明装配处的鉴权中间件
    //      真的把 requiredClaims / algorithms 白名单接进了路由——两个令牌在 jose
    //      看来都"签名有效"，只有策略层能拒。独立用 jose 构造，不走 signToken。
    const srv = await buildServer();
    try {
      const key = new TextEncoder().encode(JWT_SECRET);
      const noExp = await new SignJWT({ role: 'user', ver: 1 })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u-1')
        .setIssuer('waselect')
        .setAudience(AUDIENCE.user)
        .setIssuedAt()
        .sign(key);
      const hs512 = await new SignJWT({ role: 'user', ver: 1 })
        .setProtectedHeader({ alg: 'HS512' })
        .setSubject('u-1')
        .setIssuer('waselect')
        .setAudience(AUDIENCE.user)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);
      for (const [label, bad] of [
        ['no-exp', noExp],
        ['hs512', hs512],
      ] as const) {
        const r = await get(srv.url, '/api/v1/orders', bad);
        expect(r.status, label).toBe(401);
        expect(r.json['code'], label).toBe(40101);
      }
      // 控制组：同密钥、正规签发（HS256 + exp）→ 200，证明拒的是策略不是密钥/签发者
      const ok = await get(srv.url, '/api/v1/orders');
      expect(ok.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
