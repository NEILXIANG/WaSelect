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

/** 配置默认值（用例不另设，测的就是默认行为；与 config.ts 的默认值由 config 单测钉住）。 */
const MAX_OPEN_ORDERS_DEFAULT = 3;

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
      const t0 = Date.now();
      const r = await create(srv.url, BODY);
      const t1 = Date.now();
      expect(r.status).toBe(201);
      expect(r.json['total_jpy']).toBe(TOTAL);
      expect(r.json['status']).toBe('created');
      expect(typeof r.json['order_no']).toBe('string');
      expect(r.json['fx_snapshot']).toMatchObject({ USD: 0.0067, CNY: 0.049 });
      // expires_at = 下单时刻 + **恰好 30 分钟**（D-33）。路由时钟不可注入，所以夹在请求前后：
      // 原写法容差 ±2 分钟，29 或 31 分钟的 TTL 也能过（测试审查 U-J11）
      const expiresAt = Date.parse(String(r.json['expires_at']));
      expect(expiresAt).toBeGreaterThanOrEqual(t0 + 30 * 60_000);
      expect(expiresAt).toBeLessThanOrEqual(t1 + 30 * 60_000);

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
      // ORD3-04：NUL（以及别的控制字符）必须**在入口这层**挡掉——放行的话 PG 拒收 0x00 → 22021，
      // 兜底层虽然也能把它映射成 40001，但那已经是一次白跑的库查询 + 一条带 sqlstate 的日志
      // MP-9（AJ-479）：域名必须像域名——无点 / 连点 / 后缀过短 / 纯数字后缀 → 40001（邮件是唯一通知渠道，填错 = 失联）
      for (const [i, bad] of ['a@b', 'x@b..com', 'x@b.c', 'jane@example.123'].entries()) {
        const r = await create(srv.url, { ...BODY, contact_email: bad }, `ce-dom-${i}`);
        expect(r.status, bad).toBe(400);
        expect(r.json['code']).toBe(40001);
      }
      for (const [i, bad] of ['a\u0000@b', 'a@b\u0007', 'a\u001fb@c.io'].entries()) {
        const r = await create(srv.url, { ...BODY, contact_email: bad }, `ce-ctl-${i}`);
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.json['code']).toBe(40001);
      }
      // 没有落到"库拒收"分支上：入口挡住了，就不该出现 sqlstate
      expect(srv.sink.find('request_rejected').filter((l) => 'sqlstate' in l)).toHaveLength(0);
      const ok = await create(srv.url, { ...BODY, contact_email: 'hanako@example.com' }, 'ce-ok');
      expect(ok.status).toBe(201);
    } finally {
      await srv.close();
    }
  });

  it('库存不足 → 40901（整单回滚，其它商品也不扣）；他人地址 → 40400；超重 → 40912；缺 fx → 50003', async () => {
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
      expect(Number(cup[0]?.['stock'])).toBe(10); // 预检阶段即拒，没有任何扣减发生（"扣到一半失败的整单回滚"见 order-failure-consistency.db.test.ts）

      // 不存在的地址 → 40400（"他人**真实**地址"的越权用例在 order-failure-consistency.db.test.ts）
      const others = await create(srv.url, { ...BODY, address_id: 'addr-ghost' }, 's2');
      expect(others.json['code']).toBe(40400);

      const heavy = await create(
        srv.url,
        { ...BODY, items: [{ product_id: 'p-heavy', qty: 6 }] },
        's3',
      );
      // AJ-239：超重是买家可以自己解决的事（拆单），不是 5xx
      expect(heavy.json['code']).toBe(40912);

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

  it('pending_payment + initiated 支付行 → 200：支付行作废为 cancelled（真实发起支付后取消、回调随后到达的整链见 order-golden-chain.db.test.ts）', async () => {
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

/**
 * AJ-240（第二轮审查 ORD2-01）：每个用户的**在途单**（created / pending_payment）有数量上限。
 *
 * @why 库存在**建单时**就扣，30 分钟后才由关单作业回补；而限流只按 IP（每分钟 30 次）。
 *      于是任何一个登录用户都能零成本地循环建单：每张单把若干 SKU 的库存占满，到期后立刻续上——
 *      全店对其他买家一直是"库存不足"，而六类对账一条都不会报（每一张单都是"合法的待付款单"）。
 *      上限同时兜住另一件事：结算页在"上一次提交结果未知 + 内容又变了"时会换幂等键（AJ-228），
 *      可能多出一张未付款的单——有了上限，它不会无限多出来。
 */
describe('POST /orders：每用户在途单上限（AJ-240）', () => {
  const ONE_CUP = { ...BODY, items: [{ product_id: 'p-cup', qty: 1 }] };
  const stockOf = async (id: string): Promise<number> =>
    Number((await db`select stock from products where id = ${id}`)[0]?.['stock']);

  it('🔴 超过上限的那一张 → 409 / 40913，且**不扣库存**；已有的在途单不受影响', async () => {
    const srv = await buildServer();
    try {
      for (let i = 1; i <= MAX_OPEN_ORDERS_DEFAULT; i += 1) {
        expect((await create(srv.url, ONE_CUP, `cap-${String(i)}`)).status).toBe(201);
      }
      const before = await stockOf('p-cup');
      const over = await create(srv.url, ONE_CUP, 'cap-over');
      expect(over.status).toBe(409);
      expect(over.json['code']).toBe(40913);
      expect(await stockOf('p-cup')).toBe(before);
      const open = await db`select count(*)::int as n from orders where user_id = 'u-1'`;
      expect(Number(open[0]?.['n'])).toBe(MAX_OPEN_ORDERS_DEFAULT);
    } finally {
      await srv.close();
    }
  });

  it('取消一张之后可以再下；已付款 / 已取消的单不计入在途', async () => {
    const srv = await buildServer();
    try {
      const ids: string[] = [];
      for (let i = 1; i <= MAX_OPEN_ORDERS_DEFAULT; i += 1) {
        const r = await create(srv.url, ONE_CUP, `cap-${String(i)}`);
        ids.push(String(r.json['order_id']));
      }
      await db`update orders set status = 'cancelled' where id = ${ids[0] ?? ''}`;
      await db`update orders set status = 'paid' where id = ${ids[1] ?? ''}`;
      expect((await create(srv.url, ONE_CUP, 'cap-a')).status).toBe(201);
      expect((await create(srv.url, ONE_CUP, 'cap-b')).status).toBe(201);
      expect((await create(srv.url, ONE_CUP, 'cap-c')).json['code']).toBe(40913);
    } finally {
      await srv.close();
    }
  });

  it('上限按**用户**算：别人的在途单不占我的额度', async () => {
    const srv = await buildServer();
    try {
      await db`insert into users (id, openid) values ('u-2', 'o-2')`;
      for (let i = 1; i <= MAX_OPEN_ORDERS_DEFAULT; i += 1) {
        await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                     total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
                 values (${`o-other-${String(i)}`}, ${`W-other-${String(i)}`}, 'u-2', 'pending_payment', 1, 0, 0, 1, 1,
                         '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
      }
      expect((await create(srv.url, ONE_CUP, 'cap-mine')).status).toBe(201);
    } finally {
      await srv.close();
    }
  });

  it('🔴 并发：同一用户同时发 8 张（各用各的幂等键）→ 恰好上限张成功，其余 40913，库存只扣成功的那几张', async () => {
    const srv = await buildServer();
    try {
      const before = await stockOf('p-cup');
      const burst = await Promise.all(
        Array.from({ length: 8 }, (_, i) => create(srv.url, ONE_CUP, `burst-${String(i)}`)),
      );
      const created = burst.filter((r) => r.status === 201).length;
      const capped = burst.filter((r) => r.json['code'] === 40913).length;
      expect(created).toBe(MAX_OPEN_ORDERS_DEFAULT);
      expect(capped).toBe(8 - MAX_OPEN_ORDERS_DEFAULT);
      expect(await stockOf('p-cup')).toBe(before - MAX_OPEN_ORDERS_DEFAULT);
    } finally {
      await srv.close();
    }
  });

  it('🔴 建单事务内复核拉黑：token 还有效（身份缓存最长 60 秒）也不能再建单 → 40301', async () => {
    const srv = await buildServer();
    try {
      // 先让身份进缓存，再拉黑——模拟"刚被拉黑的人 60 秒内还拿着有效身份"
      expect((await create(srv.url, ONE_CUP, 'blk-1')).status).toBe(201);
      await db`update users set blocked_at = now() where id = 'u-1'`;
      const r = await create(srv.url, ONE_CUP, 'blk-2');
      expect(r.json['code']).toBe(40301);
      const n = await db`select count(*)::int as n from orders where user_id = 'u-1'`;
      expect(Number(n[0]?.['n'])).toBe(1);
    } finally {
      await srv.close();
    }
  });
});
