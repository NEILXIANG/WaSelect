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
import { checkShape, contractSchema } from '../../../test/helpers/contract-schema.js';
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

/**
 * @param imgBaseUrl 传了才塞进 config（只有 AJ-361 那条用例需要显式配图床域名）。
 */
async function buildServer(
  imgBaseUrl?: string,
): Promise<{ url: string; close: () => Promise<void> }> {
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
    ...(imgBaseUrl === undefined ? {} : { IMG_BASE_URL: imgBaseUrl }),
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

// AJ-430（契约 0.6.60，统一结论 5.3 ④）：「售后·退款」页签要能找到有售后申请、但状态仍是已送达 / 已完成的单。
// 列表行加只读 `after_sale_state`（open / closed / null），恒下发；不新增查询语义（列表本就不分页、一次取全）。
describe('AJ-430：GET /orders 列表行带售后状态', () => {
  it('🔴 有进行中售后 → open；售后已结案 → closed；没有售后 → null（字段恒下发）', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrder(srv.url, 'as-open');
      const b = await createOrder(srv.url, 'as-closed');
      const c = await createOrder(srv.url, 'as-none');
      const [o] = await db`select user_id from orders where id = ${a}`;
      const uid = String(o?.['user_id']);
      await db`update orders set status = 'delivered' where id in ${db([a, b, c])}`;
      await db`
        insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
        values ('as-1', ${a}, ${uid}, 'damaged', '外箱压扁，罐子凹了', 'processing', now(), now()),
               ('as-2', ${b}, ${uid}, 'not_received', '物流显示签收但没收到', 'resolved', now(), now())`;
      const r = await get(srv.url, '/api/v1/orders');
      const byId = new Map(
        (r.json['items'] as Array<Record<string, unknown>>).map((i) => [i['order_id'], i]),
      );
      expect(byId.get(a)?.['after_sale_state']).toBe('open');
      expect(byId.get(b)?.['after_sale_state']).toBe('closed');
      expect(byId.get(c)).toHaveProperty('after_sale_state', null);
    } finally {
      await srv.close();
    }
  });

  // 严格检查补测（2026-10-10）：真实形态"被驳回后再申请"——同一单一条 rejected + 一条 open；
  // 以及 open / rejected 原值各自的归类。SQL 先判"进行中"再判"有任何申请"，顺序改坏时这条会红。
  it('🔴 同一单"驳回后再申请"（rejected + open）→ open；只有 rejected → closed；只有 open → open', async () => {
    const srv = await buildServer();
    try {
      const d = await createOrder(srv.url, 'as-reapply');
      const e = await createOrder(srv.url, 'as-rejected');
      const f = await createOrder(srv.url, 'as-open-only');
      const [o] = await db`select user_id from orders where id = ${d}`;
      const uid = String(o?.['user_id']);
      await db`update orders set status = 'delivered' where id in ${db([d, e, f])}`;
      await db`
        insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
        values ('as-r1', ${d}, ${uid}, 'damaged', '第一次：外箱压扁', 'rejected', now() - interval '2 days', now() - interval '1 day'),
               ('as-r2', ${d}, ${uid}, 'quality', '第二次：漏液了一半', 'open', now(), now()),
               ('as-r3', ${e}, ${uid}, 'other', '不想要了', 'rejected', now(), now()),
               ('as-r4', ${f}, ${uid}, 'wrong_item', '发错了口味', 'open', now(), now())`;
      const r = await get(srv.url, '/api/v1/orders');
      const byId = new Map(
        (r.json['items'] as Array<Record<string, unknown>>).map((i) => [i['order_id'], i]),
      );
      expect(byId.get(d)?.['after_sale_state']).toBe('open');
      expect(byId.get(e)?.['after_sale_state']).toBe('closed');
      expect(byId.get(f)?.['after_sale_state']).toBe('open');
    } finally {
      await srv.close();
    }
  });
});

// AJ-435（契约 0.6.61，用户 2026-10-10 授权代决）：列表行带付款截止时刻 `expires_at`，小程序待付款行据此写明"几点前付款"。
// 与详情 GET /orders/{id} 的 expires_at 是同一列、同一格式（ISO 8601 UTC）；orders.expires_at NOT NULL，所以恒下发。
describe('AJ-435：GET /orders 列表行带 expires_at', () => {
  it('🔴 每行都有 expires_at，值与该单详情里的 expires_at 完全一致（含已付款的单）', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrder(srv.url, 'exp-a');
      const b = await createOrder(srv.url, 'exp-b');
      await db`update orders set status = 'paid' where id = ${b}`;
      const r = await get(srv.url, '/api/v1/orders');
      const items = r.json['items'] as Array<Record<string, unknown>>;
      expect(items.length).toBe(2);
      for (const id of [a, b]) {
        const row = items.find((i) => i['order_id'] === id);
        const detail = await get(srv.url, `/api/v1/orders/${id}`);
        expect(row?.['expires_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(row?.['expires_at']).toBe(detail.json['expires_at']);
      }
    } finally {
      await srv.close();
    }
  });
});

// AJ-408（契约 0.6.49，M-10 / M-11）：买家列表的多状态页签 + 列表行缩略图与件数。
// @why 严格档（对外契约 + 归属过滤）：页签"待付款 = created + pending_payment"、"售后·退款 = refunding + refunded"
//      要一次请求取齐；校验口径与管理端同一个 shared `parseOrderStatusList`（AJ-400），两端行为不许分叉。
describe('AJ-408：GET /orders 多状态过滤（M-10）', () => {
  async function createOrderAs(url: string, key: string, auth: string): Promise<string> {
    const res = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth}`,
        'idempotency-key': key,
      },
      body: JSON.stringify(auth === token ? BODY : { ...BODY, address_id: 'addr-2' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { order_id: string }).order_id;
  }
  const ids = (r: { json: Record<string, unknown> }): unknown[] =>
    (r.json['items'] as Array<Record<string, unknown>>).map((i) => i['order_id']);

  it('🔴 逗号多选任一命中、重复值去重；单值老写法照旧', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrderAs(srv.url, 'm1', token);
      const b = await createOrderAs(srv.url, 'm2', token);
      await db`update orders set status = 'paid' where id = ${b}`;
      expect(ids(await get(srv.url, '/api/v1/orders?status=created,pending_payment'))).toEqual([a]);
      expect(ids(await get(srv.url, '/api/v1/orders?status=paid,created'))).toEqual([b, a]);
      expect(ids(await get(srv.url, '/api/v1/orders?status=refunding,refunded'))).toEqual([]);
      expect(ids(await get(srv.url, '/api/v1/orders?status=created,created'))).toEqual([a]);
      expect(ids(await get(srv.url, '/api/v1/orders?status=paid'))).toEqual([b]);
    } finally {
      await srv.close();
    }
  });

  it('🔴 非法形态一律 40001 status_invalid：空串 / 空段 / 未知段 / 重复给参数', async () => {
    const srv = await buildServer();
    try {
      await createOrderAs(srv.url, 'm1', token);
      for (const q of [
        'status=',
        'status=created,',
        'status=,created',
        'status=created,,paid',
        'status=created,unpaid',
        'status=Created',
        'status=created&status=paid',
      ]) {
        const r = await get(srv.url, `/api/v1/orders?${q}`);
        expect([q, r.status, r.json['code']]).toEqual([q, 400, 40001]);
      }
    } finally {
      await srv.close();
    }
  });

  it('🔴 归属：多状态过滤下也只看得到自己的单（两个买家各有同态订单）', async () => {
    await db`
      insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country, is_default)
      values ('addr-2', 'u-2', 'John Roe', '+12125550188', '350 5th Ave', 'New York', 'NY', '10118', 'US', true)
    `;
    const srv = await buildServer();
    try {
      const mine = await createOrderAs(srv.url, 'm1', token);
      const theirs = await createOrderAs(srv.url, 'm2', token2);
      const q = '/api/v1/orders?status=created,pending_payment';
      expect(ids(await get(srv.url, q))).toEqual([mine]);
      expect(ids(await get(srv.url, q, token2))).toEqual([theirs]);
      expect(ids(await get(srv.url, '/api/v1/orders'))).toEqual([mine]);
    } finally {
      await srv.close();
    }
  });
});

describe('AJ-408：列表行缩略图与件数（M-11）', () => {
  async function createWith(
    url: string,
    key: string,
    items: Array<{ product_id: string; qty: number }>,
  ): Promise<string> {
    const res = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
      },
      body: JSON.stringify({ ...BODY, items }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { order_id: string }).order_id;
  }
  const row = async (url: string, id: string): Promise<Record<string, unknown> | undefined> =>
    ((await get(url, '/api/v1/orders')).json['items'] as Array<Record<string, unknown>>).find(
      (i) => i['order_id'] === id,
    );

  it('🔴 item_count = 各行 qty 之和（不是行数）；first_image = 买家下单顺序第一行商品的首图', async () => {
    const srv = await buildServer();
    try {
      const id = await createWith(srv.url, 'i1', [
        { product_id: 'p-knife', qty: 1 },
        { product_id: 'p-cup', qty: 2 },
      ]);
      const r = await row(srv.url, id);
      expect(r?.['item_count']).toBe(3); // knife×1 + cup×2
      // A8（AJ-416，契约 0.6.54）：第一行商品的**下单快照**标题（买家看到的那个名字，不是现名、不是日文采购名）
      expect(r?.['first_title']).toBe('Chef Knife');
      expect(r?.['first_image']).toEqual({
        thumb: 'https://img.example.com/knife.jpg',
        card: 'https://img.example.com/knife.jpg',
        detail: 'https://img.example.com/knife.jpg',
      });
      expect(typeof r?.['created_at']).toBe('string');
    } finally {
      await srv.close();
    }
  });

  it('🔴 第一行商品没有图 → first_image 整键省略（不拿第二行的图顶替、不给空串）', async () => {
    const srv = await buildServer();
    try {
      const id = await createWith(srv.url, 'i2', [
        { product_id: 'p-cup', qty: 2 },
        { product_id: 'p-knife', qty: 1 },
      ]);
      const r = await row(srv.url, id);
      expect(r?.['item_count']).toBe(3);
      expect(r !== undefined && 'first_image' in r).toBe(false);
      expect(r?.['first_title']).toBe('Tea Cup'); // 首行是 cup（下单顺序），标题跟着首行走
      // 改了商品名之后列表仍是下单时的名字（快照，与详情行项目同口径）
      await db`update products set title = 'Tea Cup (Renamed)' where id = 'p-cup'`;
      expect((await row(srv.url, id))?.['first_title']).toBe('Tea Cup');
    } finally {
      await srv.close();
    }
  });

  it('🔴 首图按 image_id 存：配了 IMG_BASE_URL → 三档 URL（与详情同一 toImageSet）；没配 → 整键省略', async () => {
    await db`update products set images = ${db.json([{ image_id: 'img-7qk3m9vz2rx8' }])} where id = 'p-knife'`;
    const withBase = await buildServer('https://img.example.com');
    let id = '';
    try {
      id = await createWith(withBase.url, 'i3', [{ product_id: 'p-knife', qty: 1 }]);
      const r = await row(withBase.url, id);
      expect(r?.['item_count']).toBe(1);
      expect(r?.['first_image']).toEqual({
        thumb: 'https://img.example.com/img/img-7qk3m9vz2rx8/thumb.webp',
        card: 'https://img.example.com/img/img-7qk3m9vz2rx8/card.webp',
        detail: 'https://img.example.com/img/img-7qk3m9vz2rx8/detail.webp',
      });
    } finally {
      await withBase.close();
    }
    const noBase = await buildServer();
    try {
      const r = await row(noBase.url, id);
      expect(r !== undefined && 'first_image' in r).toBe(false);
    } finally {
      await noBase.close();
    }
  });

  it('详情形状不变：GET /orders/{id} 不带 item_count / first_image（只加在列表行）', async () => {
    const srv = await buildServer();
    try {
      const id = await createWith(srv.url, 'i4', [{ product_id: 'p-knife', qty: 1 }]);
      const d = await get(srv.url, `/api/v1/orders/${id}`);
      expect('item_count' in d.json).toBe(false);
      expect('first_image' in d.json).toBe(false);
      expect('first_title' in d.json).toBe(false);
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

describe('买家可见的迟到付款与部分退款（P2-11 / P2-12，AJ-386）', () => {
  it('🔴 默认：late_paid=false，partial_refunds=[]', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.json['late_paid']).toBe(false);
      expect(r.json['partial_refunds']).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('🔴 关单后才到的付款 → late_paid=true（买家看到"已收到付款，正在退款"，而不是"请重新下单"）', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      await db`insert into order_events (order_id, status, actor, note)
               values (${orderId}, 'late_paid', 'provider:stripe', 'pay-x')`;
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.json['late_paid']).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('🔴 部分退款：成功与处理中的带出（不含管理员原因与操作人）；失败的不出现（钱没动）', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
               values ('pay-1', ${orderId}, 'mock', 'succeeded', 'USD', 14000)`;
      await db`
        insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
        values ('rf-1', ${orderId}, 'pay-1', 'USD', 1200, '内部备注：客户难缠', 'succeeded', 'admin:u-a', now() - interval '2 hours'),
               ('rf-2', ${orderId}, 'pay-1', 'USD', 800, 'x', 'pending', 'admin:u-a', now() - interval '1 hour'),
               ('rf-3', ${orderId}, 'pay-1', 'USD', 500, 'x', 'failed', 'admin:u-a', now())`;
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      const rows = r.json['partial_refunds'] as Array<Record<string, unknown>>;
      expect(rows.map((x) => [x['status'], x['amount_minor'], x['currency']])).toEqual([
        ['succeeded', 1200, 'USD'],
        ['pending', 800, 'USD'],
      ]);
      expect(JSON.stringify(rows)).not.toContain('客户难缠');
      expect(JSON.stringify(rows)).not.toContain('admin:');
    } finally {
      await srv.close();
    }
  });
});

/**
 * AJ-500（用户 2026-10-12 同意）：拒付期间买家原先只看到"已付款 · 日本采购中"——买家多是没认出扣款名目就去银行争议，
 * 写明"银行正在处理争议、暂不发货"后，误发起的买家会去撤回。列表与详情都带 payment_dispute。
 */
describe('AJ-500：买家看得到拒付状态（payment_dispute）', () => {
  const dispute = async (orderId: string, status: string, hold: boolean) => {
    await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                                   dispute_id, dispute_status, dispute_amount, dispute_opened_at)
             values (${`pay-${status}`}, ${orderId}, 'mock', 'succeeded', 'JPY', 1000,
                     ${`dp-${status}`}, ${status}, 1000, now())`;
    await db`update orders set status = 'paid', has_dispute = ${hold} where id = ${orderId}`;
  };
  const listItem = async (url: string, orderId: string) =>
    ((await get(url, '/api/v1/orders')).json['items'] as Array<Record<string, unknown>>).find(
      (i) => i['order_id'] === orderId,
    );

  it('🔴 进行中 → 详情与列表都是 open；败诉（钱已被银行退回）→ lost', async () => {
    const srv = await buildServer();
    try {
      const a = await createOrder(srv.url, 'd1');
      await dispute(a, 'open', true);
      expect((await get(srv.url, `/api/v1/orders/${a}`)).json['payment_dispute']).toBe('open');
      expect((await listItem(srv.url, a))?.['payment_dispute']).toBe('open');
      await db`update payments set dispute_status = 'lost' where order_id = ${a}`;
      expect((await get(srv.url, `/api/v1/orders/${a}`)).json['payment_dispute']).toBe('lost');
      expect((await listItem(srv.url, a))?.['payment_dispute']).toBe('lost');
    } finally {
      await srv.close();
    }
  });

  it('🔴 胜诉 / 撤回（拒付标记已解除）或从没拒付 → 不带这个键', async () => {
    const srv = await buildServer();
    try {
      const won = await createOrder(srv.url, 'd2');
      await dispute(won, 'won', false);
      expect((await get(srv.url, `/api/v1/orders/${won}`)).json).not.toHaveProperty(
        'payment_dispute',
      );
      expect(await listItem(srv.url, won)).not.toHaveProperty('payment_dispute');
      // 运营人工解除拒付限制（AJ-291）：订单标记清掉、支付行仍是 lost——货会照常发，不能再对买家说"暂不发货"
      const released = await createOrder(srv.url, 'd4');
      await dispute(released, 'lost', false);
      expect((await get(srv.url, `/api/v1/orders/${released}`)).json).not.toHaveProperty(
        'payment_dispute',
      );
      expect(await listItem(srv.url, released)).not.toHaveProperty('payment_dispute');
      const none = await createOrder(srv.url, 'd3');
      expect((await get(srv.url, `/api/v1/orders/${none}`)).json).not.toHaveProperty(
        'payment_dispute',
      );
    } finally {
      await srv.close();
    }
  });
});

describe('fx_snapshot 脏汇率：读路径降级，不许整页 500（AJ-359）', () => {
  // @why 造脏数据用 jsonb_set 只改一个键、其余保持建单链路真值：
  //      "整快照手写"会连带把 CNY 也固定成我猜的值，那就分不清"降级"与"我写错了"。
  it('列表：脏的那个币种少显示，其余照常（≤0 那一支）', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      // 不是"缺币"（那本来就降级），是"有币但是坏的"——0 会被 toRateInt 拒
      await db`
        update orders set fx_snapshot = jsonb_set(fx_snapshot, '{USD}', '0'::jsonb)
        where id = ${orderId}
      `;
      const r = await get(srv.url, '/api/v1/orders');
      expect(r.status).toBe(200);
      const items = r.json['items'] as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]?.['total_jpy']).toBe(TOTAL); // 金额段不受展示价影响
      expect(items[0]?.['display']).toEqual({ CNY: toMinor(TOTAL, toRateInt('0.049')) });
    } finally {
      await srv.close();
    }
  });

  it('详情：脏汇率同上（|rate| ≥ 1e6 那一支），其余字段照常出', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'q1');
      await db`
        update orders set fx_snapshot = jsonb_set(fx_snapshot, '{CNY}', '1234567'::jsonb)
        where id = ${orderId}
      `;
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.status).toBe(200);
      expect(r.json['display']).toEqual({ USD: toMinor(TOTAL, toRateInt('0.0067')) });
      expect(r.json['items_jpy']).toBe(15_200);
      expect(r.json['terms_version']).toBe('TOS-TEST-1');
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

// ═══════════════════════════════════════════════════════════════════════════
// AJ-361（CAT2-08 第一步）：订单详情的行项目图也认 image_id
// ═══════════════════════════════════════════════════════════════════════════
//
// @why 订单详情的图走的是**第三个**装配点（`order-views` → `toOrderItemView`），
//      与买家商品页、管理端列表各一份 `IMG_BASE_URL` 的传递。三处只要漏一处，
//      表现就是"订单里的商品图没了"——而订单是**快照**，商品页还正常，
//      于是看起来像"这张图的存储被删了"，排障方向从一开始就错。
// @why 改商品图必须在**建单之前**：`order_items.images` 是下单时的快照，
//      建单后再改 `products.images` 不会影响这条订单（本文件其余用例都依赖这个语义）。
describe('AJ-361：订单行项目图按 image_id 存', () => {
  it('🔴 商品图存 {image_id} → 订单详情行项目读回三档 URL', async () => {
    // ⚠️ 用 `db.json()` 而不是 `${JSON.stringify(...)}::jsonb`：后者会被 postgres.js
    //    按 jsonb 二次编码（存进去是"JSON 字符串包着 JSON"，读回是 string 不是 array）。
    await db`
      update products
         set images = ${db.json([{ image_id: 'img-7qk3m9vz2rx8' }])}
       where id = 'p-knife'
    `;
    const srv = await buildServer('https://img.example.com');
    try {
      const orderId = await createOrder(srv.url, 'q1');
      const r = await get(srv.url, `/api/v1/orders/${orderId}`);
      expect(r.status).toBe(200);
      const items = (
        r.json as {
          items: Array<{ product_id: string; image?: Record<string, string> }>;
        }
      ).items;
      expect(items.find((i) => i.product_id === 'p-knife')?.image).toEqual({
        thumb: 'https://img.example.com/img/img-7qk3m9vz2rx8/thumb.webp',
        card: 'https://img.example.com/img/img-7qk3m9vz2rx8/card.webp',
        detail: 'https://img.example.com/img/img-7qk3m9vz2rx8/detail.webp',
      });
    } finally {
      await srv.close();
    }
  });
});

/**
 * E-8（工程缺口 2026-10-08）：买家订单接口的响应形状按契约 schema 校验。
 * @why 用一张"字段尽量满"的单（已发货 + 成功支付 + 部分退款 + 售后 + 迟到付款凭据），
 *      让可选键尽量都出现——只出现了的键才会被校验，空单验不到它们。
 */
describe('E-8：GET /orders 与 /orders/{id} 的响应形状 = 契约 OrderListItem / Order', () => {
  it('字段尽量满的一张单：列表行符合 OrderListItem，详情符合 Order', async () => {
    const srv = await buildServer();
    try {
      const orderId = await createOrder(srv.url, 'e8');
      await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount, paid_amount, paid_currency)
               values ('pay-e8', ${orderId}, 'mock', 'succeeded', 'USD', 14000, 14000, 'USD')`;
      await db`update orders set status = 'shipped', paid_at = now(), shipped_at = now(),
                                 carrier = 'Japan Post', tracking_no = 'EM123456789JP',
                                 contact_email = 'jane.doe@example.com'
                where id = ${orderId}`;
      await db`insert into order_events (order_id, status, actor) values (${orderId}, 'paid', 'provider:mock'), (${orderId}, 'shipped', 'admin:u-a')`;
      await db`insert into order_refunds (id, order_id, payment_id, currency, amount_minor, reason, status, actor, created_at)
               values ('rf-e8', ${orderId}, 'pay-e8', 'USD', 1200, '破损', 'succeeded', 'admin:u-a', now())`;
      await db`insert into after_sale_requests (id, order_id, user_id, reason, description, created_at, updated_at)
               select 'as-e8', id, user_id, 'damaged', '外箱压坏', now(), now() from orders where id = ${orderId}`;
      const all = contractSchema();
      const list = (await get(srv.url, '/api/v1/orders')).json['items'] as unknown[];
      expect(list.length).toBeGreaterThan(0);
      list.forEach((it, i) =>
        expect(checkShape(all, 'OrderListItem', it), `items[${String(i)}]`).toEqual([]),
      );
      const detail = (await get(srv.url, `/api/v1/orders/${orderId}`)).json;
      expect(detail['tracking_url']).toBeDefined(); // 确认可选键真的出现了，否则下面那条验不到它
      expect(detail['after_sale']).toBeDefined();
      expect(checkShape(all, 'Order', detail)).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

/**
 * 第二轮审计 S-7（契约 0.6.69，AJ-481）：买家订单列表分页、「售后·退款」页签改由服务端筛选、「我的」角标改由服务端计数。
 * @why 原接口一次返回该买家全部订单（每行 4 个子查询），复购多的买家越积越慢，小程序一次 setData 的数据量也有上限；
 *      「我的」角标靠取全量在本地数——列表一分页，本地就数不全了，所以计数必须同时搬到服务端。
 */
describe('S-7：GET /orders 分页 + 售后筛选；GET /orders/counts 角标计数', () => {
  /** 直接插库造单（接口建单会扣测试库存）：created_at 依次递增，i 越大越新。 */
  async function seedOrders(userId: string, statuses: readonly string[], prefix: string) {
    const ids: string[] = [];
    for (const [i, status] of statuses.entries()) {
      const id = `${prefix}-${String(i).padStart(3, '0')}`;
      ids.push(id);
      await db`
        insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy, total_jpy,
                            weight_g, fx_snapshot, address_snapshot, terms_version, expires_at, created_at)
        values (${id}, ${`WS${id}`}, ${userId}, ${status}, 12800, 4950, null, 17750, 900,
                '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes',
                now() - make_interval(mins => ${statuses.length - i}))`;
    }
    return ids;
  }
  async function afterSale(id: string, orderId: string, userId: string, status: string) {
    await db`
      insert into after_sale_requests (id, order_id, user_id, reason, description, status, created_at, updated_at)
      values (${id}, ${orderId}, ${userId}, 'damaged', '外箱压扁，罐子凹了', ${status}, now(), now())`;
  }
  const ids = (j: Record<string, unknown>) =>
    (j['items'] as Array<Record<string, unknown>>).map((i) => String(i['order_id']));

  it('🔴 25 单：默认每页 20、最新在前，带 total；第 2 页 5 单；超出页为空但 total 照给；两页无重叠', async () => {
    const all = await seedOrders(
      'u-1',
      Array.from({ length: 25 }, () => 'paid'),
      'pg',
    );
    const srv = await buildServer();
    try {
      const p1 = await get(srv.url, '/api/v1/orders');
      expect(p1.status).toBe(200);
      expect(p1.json['total']).toBe(25);
      expect(ids(p1.json)).toEqual([...all].reverse().slice(0, 20));
      const p2 = await get(srv.url, '/api/v1/orders?page=2');
      expect(p2.json['total']).toBe(25);
      expect(ids(p2.json)).toEqual([...all].reverse().slice(20));
      const p3 = await get(srv.url, '/api/v1/orders?page=3');
      expect(ids(p3.json)).toEqual([]);
      expect(p3.json['total']).toBe(25);
      const big = await get(srv.url, '/api/v1/orders?size=50');
      expect(ids(big.json)).toHaveLength(25);
    } finally {
      await srv.close();
    }
  });

  it('🔴 page / size 非法 → 40001 page_size_invalid（size 上限 50，与商品列表同口径）', async () => {
    const srv = await buildServer();
    try {
      for (const q of [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=abc',
        'size=0',
        'size=51',
        'size=x',
      ]) {
        const r = await get(srv.url, `/api/v1/orders?${q}`);
        expect(r.status, q).toBe(400);
        expect(r.json['code'], q).toBe(40001);
      }
    } finally {
      await srv.close();
    }
  });

  it('🔴 include_after_sale=1：状态命中「或」有售后申请（进行中或已结案）都收；只认 "1"', async () => {
    const [refunding, delivOpen, delivClosed, delivNone, completedOpen] = await seedOrders(
      'u-1',
      ['refunding', 'delivered', 'delivered', 'delivered', 'completed'],
      'as',
    );
    await afterSale('asr-1', String(delivOpen), 'u-1', 'open');
    await afterSale('asr-2', String(delivClosed), 'u-1', 'resolved');
    await afterSale('asr-3', String(completedOpen), 'u-1', 'processing');
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/orders?status=refunding,refunded&include_after_sale=1');
      expect(r.status).toBe(200);
      expect(new Set(ids(r.json))).toEqual(
        new Set([refunding, delivOpen, delivClosed, completedOpen]),
      );
      expect(ids(r.json)).not.toContain(delivNone);
      expect(r.json['total']).toBe(4);
      // 不带 status：只收有售后申请的
      const onlyAs = await get(srv.url, '/api/v1/orders?include_after_sale=1');
      expect(new Set(ids(onlyAs.json))).toEqual(new Set([delivOpen, delivClosed, completedOpen]));
      for (const bad of ['0', 'true', 'yes', '']) {
        const b = await get(srv.url, `/api/v1/orders?include_after_sale=${bad}`);
        expect(b.status, bad).toBe(400);
        expect(b.json['code'], bad).toBe(40001);
      }
    } finally {
      await srv.close();
    }
  });

  it('🔴 归属：别人带售后申请的单不会被 include_after_sale 的「或」带进来（漏括号 = 越权读）', async () => {
    const [mine] = await seedOrders('u-1', ['refunding'], 'own');
    const [theirs] = await seedOrders('u-2', ['delivered'], 'theirs');
    await afterSale('own-as', String(theirs), 'u-2', 'open');
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/orders?status=refunding,refunded&include_after_sale=1');
      expect(ids(r.json)).toEqual([mine]);
      expect(r.json['total']).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('🔴 GET /orders/counts：四个入口的进行中单数；有进行中售后的单算进售后·退款且只算一次；他人的单不算', async () => {
    const [, , , , refunding, delivOpen, delivClosed] = await seedOrders(
      'u-1',
      [
        'created',
        'pending_payment',
        'paid',
        'shipped',
        'refunding',
        'delivered',
        'delivered',
        'completed',
      ],
      'ct',
    );
    await afterSale('cta-1', String(refunding), 'u-1', 'open'); // 退款中 + 进行中售后：只算一次
    await afterSale('cta-2', String(delivOpen), 'u-1', 'processing');
    await afterSale('cta-3', String(delivClosed), 'u-1', 'rejected'); // 已结案：不算
    await seedOrders('u-2', ['created', 'paid', 'refunding'], 'other');
    const srv = await buildServer();
    try {
      const r = await get(srv.url, '/api/v1/orders/counts');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ unpaid: 2, to_ship: 1, shipped: 1, after_sale: 2 });
      const other = await get(srv.url, '/api/v1/orders/counts', token2);
      expect(other.json).toEqual({ unpaid: 1, to_ship: 1, shipped: 0, after_sale: 1 });
      const anon = await fetch(`${srv.url}/api/v1/orders/counts`);
      expect(anon.status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
