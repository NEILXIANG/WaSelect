/**
 * 职责：`POST /orders` 的接线级真库用例（I1-U5b）——建单全链路、幂等、
 *      40011/40905/40906/40901/40400/50003/50004 各拒单路径。
 *
 * @why 金额断言全部独立复算（toMinor/applyRate/allocate），不从响应抄数；
 *      落库断言直接查表（orders/order_items/order_events/stock），
 *      "响应说建了"与"库里真的建了"是两件事。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allocate, toMinor, toRateInt } from '@waselect/shared';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb, TEST_DB_URL } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { MemorySink } from '../../../test/helpers/memory-sink.js';
import { createLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { createEventBus } from '../adapters/event-bus.js';
import { createHttpApp, listen } from '../http.js';
import { mountAllRoutes } from './mount.js';
import { createMemoryStorage } from '../adapters/storage-memory.js';
import { BUSINESS_EVENT_LOG, registerBusinessEventLog } from './business-events.js';
import { signToken } from './auth.js';

let db: Db;
const JWT_SECRET = 'order-test-jwt-secret-'.repeat(3);

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

async function buildServer(): Promise<{
  url: string;
  sink: MemorySink;
  close: () => Promise<void>;
}> {
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
    mount: (a) => {
      // main.ts 的装配复刻：业务事件订阅者挂在总线上（order.cancelled 分发断言依赖它）
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() });
    },
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${server.port}`, sink, close: server.close };
}

let token = '';

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active'),
           ('p-cup', 'Tea Cup', 'kitchen', 3200, 480, 10, 'JP', 'active'),
           ('p-heavy', 'Stone', 'kitchen', 1000, 2000, 50, 'JP', 'active'),
           ('p-pricey', 'Pearl', 'beauty', 190000, 100, 3, 'JP', 'active')
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
});

const BODY = {
  items: [
    { product_id: 'p-knife', qty: 1 },
    { product_id: 'p-cup', qty: 2 },
  ],
  address_id: 'addr-1',
  terms_version: 'TOS-TEST-1',
};

async function create(
  url: string,
  body: unknown,
  key = 'idem-1',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// 与 BODY 对应的独立复算基准（8800 + 3200×2 = 15200；重 620+960+250=1830 → 4950 档）
const ITEMS = 15_200;
const SHIPPING = 4950;
const TOTAL = ITEMS + SHIPPING;

describe('POST /orders（建单全链路）', () => {
  it('201：响应形状 + 落库四件事（orders/order_items/order_events/stock 扣减）全部对上', async () => {
    const srv = await buildServer();
    try {
      const r = await create(srv.url, BODY);
      expect(r.status).toBe(201);
      expect(r.json['total_jpy']).toBe(TOTAL);
      expect(r.json['status']).toBe('created');
      expect(typeof r.json['order_no']).toBe('string');
      expect(r.json['fx_snapshot']).toMatchObject({ USD: 0.0067, CNY: 0.049 });
      // expires_at ≈ 30 分钟后（容差 2 分钟：测试机时钟与 DB now 有微小偏移）
      const expiresAt = Date.parse(String(r.json['expires_at']));
      expect(Math.abs(expiresAt - (Date.now() + 30 * 60_000))).toBeLessThan(120_000);

      const orderId = String(r.json['order_id']);
      const orders = await db`
        select status, items_jpy, shipping_jpy, total_jpy, weight_g, terms_version,
               address_snapshot, fx_snapshot
          from orders where id = ${orderId}
      `;
      expect(orders[0]).toMatchObject({
        status: 'created',
        items_jpy: ITEMS,
        shipping_jpy: SHIPPING,
        total_jpy: TOTAL,
        weight_g: 1830,
        terms_version: 'TOS-TEST-1',
      });
      // 修复双重编码后（U6a，insertOrder 改 tx.json）：jsonb 读回已是对象；
      // 保留 typeof 分支只为兼容修复前落库的旧行（字符串标量需再 parse 一层）
      const snapshotRaw = orders[0]?.['address_snapshot'];
      const snapshot = (
        typeof snapshotRaw === 'string' ? JSON.parse(snapshotRaw) : snapshotRaw
      ) as { recipient?: string };
      expect(snapshot.recipient).toBe('Jane Doe');

      // order_items：快照列 + 申报价值分摊（行之和 === toMinor(商品小计)）
      const items = await db`
        select product_id, title_snapshot, qty, unit_price_jpy, weight_g, declared_value_usd
          from order_items where order_id = ${orderId} order by product_id
      `;
      expect(items).toHaveLength(2);
      expect(items[1]).toMatchObject({
        product_id: 'p-knife',
        title_snapshot: 'Chef Knife',
        qty: 1,
        unit_price_jpy: 8800,
        weight_g: 620,
      });
      const declaredTotal = toMinor(ITEMS, toRateInt('0.0067'));
      const expectedDeclared = allocate(declaredTotal, [3200 * 2, 8800]); // 与 product_id 升序同序
      expect(items.map((i) => Number(i['declared_value_usd']))).toEqual(expectedDeclared);

      // 审计事件 + 库存扣减
      const events = await db`select status, actor from order_events where order_id = ${orderId}`;
      expect(events[0]).toMatchObject({ status: 'created', actor: 'user:u-1' });
      const knife = await db`select stock from products where id = 'p-knife'`;
      expect(Number(knife[0]?.['stock'])).toBe(4); // 5 - 1
      const cup = await db`select stock from products where id = 'p-cup'`;
      expect(Number(cup[0]?.['stock'])).toBe(8); // 10 - 2
    } finally {
      await srv.close();
    }
  });

  it('幂等：同 key 重放返回同一张单且库存只扣一次；同 key 不同内容 → 40908；缺 key → 40001', async () => {
    const srv = await buildServer();
    try {
      const first = await create(srv.url, BODY, 'idem-replay');
      const replay = await create(srv.url, BODY, 'idem-replay');
      expect(replay.status).toBe(201);
      expect(replay.json['order_id']).toBe(first.json['order_id']);
      const knife = await db`select stock from products where id = 'p-knife'`;
      expect(Number(knife[0]?.['stock'])).toBe(4); // 只扣一次
      // 重放时 handler 不执行 → 没有事件可发：order.created 仍只 1 条
      // （骨架 e2e 时代就有的一条；U6c 骨架退役时迁来——重放若重复发事件，
      //  下游订阅者（对账/通知）会把一单算成两单）
      const evts = await db`
        select count(*)::int as n from order_events
        where order_id = ${String(first.json['order_id'])} and status = 'created'
      `;
      expect(Number(evts[0]?.['n'])).toBe(1);

      const conflict = await create(
        srv.url,
        { ...BODY, items: [{ product_id: 'p-cup', qty: 1 }] },
        'idem-replay',
      );
      expect(conflict.json['code']).toBe(40908);

      const res = await fetch(`${srv.url}/api/v1/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(BODY),
      });
      expect(((await res.json()) as { code: number }).code).toBe(40001);
    } finally {
      await srv.close();
    }
  });

  it('terms 缺失/不匹配 → 40011；expected_total 不符 → 40905；超上限 → 40906', async () => {
    const srv = await buildServer();
    try {
      const noTerms = await create(srv.url, { ...BODY, terms_version: undefined }, 'k1');
      expect(noTerms.json['code']).toBe(40011);
      const oldTerms = await create(srv.url, { ...BODY, terms_version: 'TOS-OLD' }, 'k2');
      expect(oldTerms.json['code']).toBe(40011);

      const mismatch = await create(srv.url, { ...BODY, expected_total_jpy: TOTAL + 1 }, 'k3');
      expect(mismatch.json['code']).toBe(40905);
      const match = await create(srv.url, { ...BODY, expected_total_jpy: TOTAL }, 'k4');
      expect(match.status).toBe(201);

      const pricey = await create(
        srv.url,
        { ...BODY, items: [{ product_id: 'p-pricey', qty: 1 }] },
        'k5',
      );
      expect(pricey.json['code']).toBe(40906); // 190000 + 运费 > 180000
    } finally {
      await srv.close();
    }
  });

  it('contact_email 形状：空串 / 无 @ / 256 字符 → 40001（不能让 VARCHAR(255) 以 22001 → 500 暴露）；合法值 201', async () => {
    const srv = await buildServer();
    try {
      for (const [i, bad] of ['', 'no-at-sign', `${'a'.repeat(251)}@x.io`].entries()) {
        const r = await create(srv.url, { ...BODY, contact_email: bad }, `ce-bad-${i}`);
        expect(r.status, bad.slice(0, 20)).toBe(400);
        expect(r.json['code']).toBe(40001);
      }
      const ok = await create(srv.url, { ...BODY, contact_email: 'hanako@example.com' }, 'ce-ok');
      expect(ok.status).toBe(201);
    } finally {
      await srv.close();
    }
  });

  it('库存不足 → 40901（整单回滚，其它商品也不扣）；他人地址 → 40400；超重 → 50004；缺 fx → 50003', async () => {
    const srv = await buildServer();
    try {
      const stock = await create(
        srv.url,
        {
          ...BODY,
          items: [
            { product_id: 'p-cup', qty: 1 },
            { product_id: 'p-knife', qty: 6 }, // stock 5
          ],
        },
        's1',
      );
      expect(stock.json['code']).toBe(40901);
      const cup = await db`select stock from products where id = 'p-cup'`;
      expect(Number(cup[0]?.['stock'])).toBe(10); // 整单回滚：cup 也没被扣

      const others = await create(srv.url, { ...BODY, address_id: 'addr-ghost' }, 's2');
      expect(others.json['code']).toBe(40400);

      const heavy = await create(
        srv.url,
        { ...BODY, items: [{ product_id: 'p-heavy', qty: 6 }] },
        's3',
      );
      expect(heavy.json['code']).toBe(50004);

      await db`delete from fx_rates where quote = 'USD'`;
      const noFx = await create(srv.url, BODY, 's4');
      expect(noFx.json['code']).toBe(50003);
    } finally {
      await srv.close();
    }
  });

  it('限流挂在建单上：前 30 次穿过限流（被业务拦），第 31 次 42901', async () => {
    const srv = await buildServer();
    try {
      // 用缺 terms 的请求当探针：穿过限流 → 40011；被限流 → 42901
      const probe = { ...BODY, terms_version: 'TOS-OLD' };
      for (let i = 0; i < 30; i += 1) {
        const r = await create(srv.url, probe, `probe-${i}`);
        expect(r.json['code']).toBe(40011);
      }
      const r = await create(srv.url, probe, 'probe-31');
      expect(r.json['code']).toBe(42901);
    } finally {
      await srv.close();
    }
  });
});

describe('POST /orders/{id}/cancel（I1-U5c：取消 = 迁移 + 作废旧支付行 + 释放库存）', () => {
  async function cancel(
    url: string,
    orderId: string,
    auth: string = token,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${url}/api/v1/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}` },
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('created → 200：状态迁移 + cancelled_at + 事件 + 库存回补 + order.cancelled 分发', async () => {
    const srv = await buildServer();
    try {
      const created = await create(srv.url, BODY, 'c1');
      const orderId = String(created.json['order_id']);
      const r = await cancel(srv.url, orderId);
      expect(r.status).toBe(200);

      const row = await db`select status, cancelled_at from orders where id = ${orderId}`;
      expect(row[0]?.['status']).toBe('cancelled');
      expect(row[0]?.['cancelled_at']).not.toBeNull();
      const knife = await db`select stock from products where id = 'p-knife'`;
      expect(Number(knife[0]?.['stock'])).toBe(5); // 回补：建单扣的 1 件还回
      const cup = await db`select stock from products where id = 'p-cup'`;
      expect(Number(cup[0]?.['stock'])).toBe(10);
      const events = await db`
        select status from order_events where order_id = ${orderId} order by at, id
      `;
      expect(events.map((e) => e['status'])).toEqual(['created', 'cancelled']);
      // 领域事件真的分发了。
      // @why 断言**结构化字段**而不是"日志文本里包含 order.cancelled"：
      //      字符串包含会同时被两种东西满足——真分发了、以及**别处**一条恰好提到这个词的日志；
      //      而且改一次日志文案就失效。这里钉三件事：事件名在 ctx.domain_event 上、
      //      order_id 是这一单、result 是 dispatched。事件名放 ctx 是因为 logger 会
      //      静默丢弃 `event:` 键（business-events.ts 文件头同口径）。
      const logs = srv.sink
        .find(BUSINESS_EVENT_LOG)
        .filter(
          (r) =>
            (r['ctx'] as { domain_event?: string } | undefined)?.domain_event === 'order.cancelled',
        );
      expect(logs).toHaveLength(1); // 一次取消 → 恰好一条（重复分发会被这里兜住）
      expect(logs[0]?.['order_id']).toBe(orderId);
      expect(logs[0]?.['result']).toBe('dispatched');
    } finally {
      await srv.close();
    }
  });

  it('pending_payment + initiated 支付行 → 200：支付行作废为 cancelled（succeeded 绝不会被动）', async () => {
    const srv = await buildServer();
    try {
      const created = await create(srv.url, BODY, 'c2');
      const orderId = String(created.json['order_id']);
      await db`update orders set status = 'pending_payment' where id = ${orderId}`;
      await db`
        insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
        values ('pay-c2', ${orderId}, 'mock', 'initiated', 'JPY', ${TOTAL})
      `;
      const r = await cancel(srv.url, orderId);
      expect(r.status).toBe(200);
      const pay = await db`select status from payments where id = 'pay-c2'`;
      expect(pay[0]?.['status']).toBe('cancelled');
    } finally {
      await srv.close();
    }
  });

  it('重复取消 → 40902（状态机是天然幂等键），库存只回补一次', async () => {
    const srv = await buildServer();
    try {
      const created = await create(srv.url, BODY, 'c3');
      const orderId = String(created.json['order_id']);
      expect((await cancel(srv.url, orderId)).status).toBe(200);
      const again = await cancel(srv.url, orderId);
      expect(again.json['code']).toBe(40902);
      const knife = await db`select stock from products where id = 'p-knife'`;
      expect(Number(knife[0]?.['stock'])).toBe(5); // 不是 6：restore 不幂等，靠守卫排他
    } finally {
      await srv.close();
    }
  });

  it('paid 不可取消 → 40902；他人单与不存在同 40400（防存在性探测）', async () => {
    const srv = await buildServer();
    try {
      const created = await create(srv.url, BODY, 'c4');
      const orderId = String(created.json['order_id']);
      await db`update orders set status = 'paid' where id = ${orderId}`;
      const paid = await cancel(srv.url, orderId);
      expect(paid.json['code']).toBe(40902);

      await db`insert into users (id, openid) values ('u-2', 'o-2')`;
      const token2 = await signToken(
        { sub: 'u-2', role: 'user' },
        { secret: JWT_SECRET, issuer: 'waselect' },
      );
      const others = await cancel(srv.url, orderId, token2);
      expect(others.json['code']).toBe(40400);
      const ghost = await cancel(srv.url, 'ord-ghost');
      expect(ghost.json['code']).toBe(40400);
    } finally {
      await srv.close();
    }
  });
});
