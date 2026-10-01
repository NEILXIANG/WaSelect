/**
 * 职责：**订单域的失败链路与跨表一致性**——越权、并发、重复请求、拒绝路径、
 *      "失败发生在链路中途"时，所有相关表是否保持一致、有没有脏数据（测试审查 U-J6）。
 *
 * @why 审查逐条读过既有用例后发现，订单域"失败侧"的断言普遍只看返回码：
 *      ① 扣库存失败的分支（create-order.ts「!ok → 40901」）**全仓零覆盖**——
 *         既有 40901 用例都在报价预检阶段就被拦下，根本到不了扣减；把那一行删掉全仓仍绿，
 *         而它守的是超卖；
 *      ② "他人地址建单"用例用的是一个**不存在**的地址 id，地址归属过滤（`user_id`）无人验证——
 *         失守的后果是别人的收件人/电话被写进自己的订单并经详情接口返回；
 *      ③ 路由级"两个用户同一个 Idempotency-Key"随骨架测试退役而丢失，只剩执行器层的用例；
 *      ④ 快照（地址 / 品名 / 单价）是否真的不随源数据变化，既有断言的快照值与源值恰好相同，
 *         分不出读的是快照还是实时联表。
 *      本文件逐条补上，并用 `snapshotState` 把"零副作用"写成全表前后相等。
 *
 * @limitation 一：并发用例靠 `pg_stat_activity` 观察"请求确实卡在行锁上"再放行，
 *              不靠 sleep 碰时序（AJ-37 同口径）；若 PG 调度极端慢，等待会超时报错而不是假绿。
 * @limitation 二：40906（超单笔上限）的零副作用不在本表——触发它需要单价极高的商品，
 *              其断言已在 order-routes.db.test.ts（Pearl ×1）覆盖返回码；副作用侧与 40905 同一条代码路径。
 *
 * @see app/create-order.ts；adapters/orders.ts（findOwnedAddress / decrementStock）；
 *      adapters/idempotency.ts；test/helpers/chain-server.ts；docs/自主决策记录.md AJ-174
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  CHAIN_TOTAL_JPY,
  domainEvents,
  orderBody,
  seedChainFixture,
  snapshotState,
  tokenFor,
  waitUntil,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

let db: Db;
let srv: ChainServer;
let u1 = '';
let u2 = '';
let admin = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  srv = await buildChainServer(db);
}, 30_000);

afterAll(async () => {
  await srv.close();
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  u1 = await tokenFor('u-1');
  u2 = await tokenFor('u-2');
  admin = await tokenFor('u-admin', 'admin');
  srv.sink.clear();
});

const stock = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await db`select id, stock from products order by id`).map((r) => [
      String(r['id']),
      Number(r['stock']),
    ]),
  );
const count = async (table: 'orders' | 'order_items' | 'order_events'): Promise<number> =>
  Number((await db`select count(*)::int as n from ${db(table)}`)[0]?.['n']);

describe('越权：别人的地址 / 别人的订单', () => {
  it('用他人**真实存在**的地址建单 → 40400，全表零副作用，自己的订单列表仍为空', async () => {
    const before = await snapshotState(db);
    const r = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-steal',
      body: orderBody('addr-2'), // addr-2 属于 u-2（Taro Yamada），真实存在
    });
    expect(r.status).toBe(404);
    expect(r.json['code']).toBe(40400);
    expect(await snapshotState(db)).toEqual(before);
    const mine = await call(srv, 'GET', '/api/v1/orders', { token: u1 });
    expect(mine.json['items']).toEqual([]);
    // 响应里不得回显对方地址的任何字段（PII 不外泄）
    expect(JSON.stringify(r.json)).not.toContain('Taro');
  });

  it('他人对 created 单的 读 / 取消 / 发起支付 一律 40400，订单、库存、事件、支付行都不动', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-own',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);
    const before = await snapshotState(db);

    const read = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: u2 });
    const cancel = await call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, { token: u2 });
    const pay = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: u2,
      key: 'pay-steal',
      body: { channel: 'mock' },
    });
    for (const r of [read, cancel, pay]) {
      expect(r.status).toBe(404);
      expect(r.json['code']).toBe(40400);
    }
    expect(await snapshotState(db)).toEqual(before);
  });
});

describe('扣库存中途失败：整单回滚，失败不被幂等缓存', () => {
  it('预检通过、扣到第二件时被并发抢光 → 40901；先扣的那件回滚、订单零落库；补货后同键重试 201', async () => {
    // 另一连接先把厨刀改成 0 并**持锁不提交**：本请求的预检读到的是已提交的 5（通过），
    // 按锁序先扣茶杯（成功），再扣厨刀时卡在行锁上；放行后条件 `stock >= 1` 重评估为假 → !ok
    // ⚠️ 必须等 `locked`（持锁方的 update **真的执行完**）再发请求（AJ-177）：首版没有就位信号，
    //    云端新连接建得快、持锁方总是先到，于是一直绿；Mac 重启后首次跑，新连接握手慢，
    //    建单请求抢先扣完厨刀 → 根本没有等锁 → 探针 3 秒超时（红在 waitUntil，不是业务断言）。
    //    与 order-race.db.test.ts 的 `holdOrderLock` 同一教训（§2 第 66 条）。
    const other = testDb();
    let release: () => void = () => {};
    let locked: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const holder = other.begin(async (tx) => {
      await tx`update products set stock = 0 where id = 'p-knife'`;
      locked();
      await gate;
    });
    try {
      await ready;
      const pending = call(srv, 'POST', '/api/v1/orders', {
        token: u1,
        key: 'k-race',
        body: orderBody(),
      });
      await waitUntil(async () => {
        const rows = await db`
          select 1 from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%update products set stock = stock -%'
        `;
        return rows.length > 0;
      }, '建单请求卡在厨刀的行锁上');
      release();
      await holder;

      const r = await pending;
      expect(r.status).toBe(409);
      expect(r.json['code']).toBe(40901);
      expect(await stock()).toEqual({ 'p-cup': 10, 'p-knife': 0 }); // 茶杯的扣减已回滚，厨刀不是 -1
      expect(await count('orders')).toBe(0);
      expect(await count('order_items')).toBe(0);
      expect(await count('order_events')).toBe(0);
      expect(
        (await db`select count(*)::int as n from idempotency_keys where key like '%k-race%'`)[0]?.[
          'n'
        ],
      ).toBe(0);
      expect(domainEvents(srv.sink)).not.toContain('order.created');
    } finally {
      release();
      await other.end();
    }

    // 补货后用**同一个键**重试：失败没有被当成结果缓存 24 小时
    await db`update products set stock = 1 where id = 'p-knife'`;
    const retry = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-race',
      body: orderBody(),
    });
    expect(retry.status).toBe(201);
    expect(await stock()).toEqual({ 'p-cup': 8, 'p-knife': 0 });
  });
});

describe('重复请求：幂等键在路由层的作用域与并发', () => {
  it('两个用户恰好用了同一个 Idempotency-Key → 各自 201、两张不同的单、库存扣两次', async () => {
    const a = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'same',
      body: orderBody(),
    });
    const b = await call(srv, 'POST', '/api/v1/orders', {
      token: u2,
      key: 'same',
      body: orderBody('addr-2'),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json['order_id']).not.toBe(b.json['order_id']);
    expect(await stock()).toEqual({ 'p-cup': 6, 'p-knife': 3 });
    const owners = (await db`select user_id from orders order by user_id`).map((r) => r['user_id']);
    expect(owners).toEqual(['u-1', 'u-2']);
    const keys =
      await db`select user_id from idempotency_keys where route = 'orders.create' order by user_id`;
    expect(keys.map((r) => r['user_id'])).toEqual(['u-1', 'u-2']);
  });

  it('同一用户同一键并发连点 5 次 → 响应体全部相同、只落一张单、库存只扣一次、order.created 只发一次', async () => {
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(srv, 'POST', '/api/v1/orders', { token: u1, key: 'dbl', body: orderBody() }),
      ),
    );
    for (const r of rs) expect(r.status).toBe(201);
    const first = rs[0]?.json;
    for (const r of rs) expect(r.json).toEqual(first);
    expect(await count('orders')).toBe(1);
    expect(await stock()).toEqual({ 'p-cup': 8, 'p-knife': 4 });
    expect(domainEvents(srv.sink).filter((e) => e === 'order.created')).toHaveLength(1);
  });

  it('取消之后用原键重放建单 → 返回原 201 响应，订单仍是 cancelled，库存不再扣', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-re',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);
    expect(
      (await call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, { token: u1 })).status,
    ).toBe(200);
    const before = await snapshotState(db);

    const replay = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-re',
      body: orderBody(),
    });
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual(c.json);
    expect(await snapshotState(db)).toEqual(before); // 单没有被"复活"、库存没有再扣
  });
});

describe('拒绝路径：返回码之外，全表必须零副作用', () => {
  it.each([
    ['40905 确认价与服务端重算不符', { expected_total_jpy: CHAIN_TOTAL_JPY + 1 }, 409, 40905],
    ['40011 条款版本不符', { terms_version: 'TOS-OLD' }, 400, 40011],
  ] as const)('%s', async (_name, extra, http, code) => {
    const before = await snapshotState(db);
    const r = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: `k-${String(code)}`,
      body: orderBody('addr-1', extra),
    });
    expect(r.status).toBe(http);
    expect(r.json['code']).toBe(code);
    expect(await snapshotState(db)).toEqual(before);
  });

  it('40401 已下架商品：报价与建单都拒，零副作用', async () => {
    await db`update products set status = 'offline' where id = 'p-cup'`;
    const before = await snapshotState(db);
    const q = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: u1,
      body: { items: [{ product_id: 'p-cup', qty: 1 }] },
    });
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-off',
      body: orderBody(),
    });
    expect(q.json['code']).toBe(40401);
    expect(c.json['code']).toBe(40401);
    expect(await snapshotState(db)).toEqual(before);
  });

  it('40908 同键换内容：首单不受影响，第二次不落任何东西', async () => {
    const first = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-x',
      body: orderBody(),
    });
    expect(first.status).toBe(201);
    const before = await snapshotState(db);
    const r = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-x',
      body: { ...(orderBody() as object), items: [{ product_id: 'p-cup', qty: 1 }] },
    });
    expect(r.status).toBe(409);
    expect(r.json['code']).toBe(40908);
    expect(await snapshotState(db)).toEqual(before);
  });
});

describe('快照一致性：订单是下单那一刻的事实，不随源数据变化', () => {
  it('下单后改/删地址、管理端改品名与价格 → 买家详情仍是下单时的地址/品名/单价/总价，发起支付按原价扣', async () => {
    const c = await call(srv, 'POST', '/api/v1/orders', {
      token: u1,
      key: 'k-snap',
      body: orderBody(),
    });
    const orderId = String(c.json['order_id']);

    // 买家改地址再删掉
    const put = await call(srv, 'PUT', '/api/v1/addresses/addr-1', {
      token: u1,
      body: {
        recipient: 'Someone Else',
        phone: '+14155550000',
        line1: '2 New Street',
        city: 'Austin',
        state: 'TX',
        postal_code: '73301',
        country: 'US',
        is_default: true,
      },
    });
    expect(put.status).toBe(200);
    expect([200, 204]).toContain(
      (await call(srv, 'DELETE', '/api/v1/addresses/addr-1', { token: u1 })).status,
    );

    // 管理端改厨刀的品名与价格（经真实管理端路由，不是直接改库）
    const got = await call(srv, 'GET', '/api/v1/admin/products?size=50', { token: admin });
    const knife = (got.json['items'] as Record<string, unknown>[]).find(
      (p) => p['id'] === 'p-knife',
    );
    expect(knife).toBeDefined();
    const upd = await call(srv, 'PUT', '/api/v1/admin/products/p-knife', {
      token: admin,
      body: {
        expected_updated_at: String(knife?.['updated_at']), // 乐观锁凭据（ADM3-02 / 契约 0.6.18）
        title: 'Chef Knife (Renamed)',
        category: 'kitchen',
        price_jpy: 9900,
        weight_g: 620,
        stock: Number(knife?.['stock']),
        customs_desc_en: 'kitchen knife, stainless steel',
        origin_country: 'JP',
      },
    });
    expect(upd.status).toBe(200);

    const g = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token: u1 });
    expect(g.status).toBe(200);
    expect((g.json['address'] as Record<string, unknown>)['recipient']).toBe('Jane Doe');
    expect((g.json['address'] as Record<string, unknown>)['city']).toBe('Cupertino');
    const knifeLine = (g.json['items'] as Record<string, unknown>[]).find(
      (i) => i['product_id'] === 'p-knife',
    );
    expect(knifeLine?.['title']).toBe('Chef Knife');
    expect(knifeLine?.['unit_price_jpy']).toBe(8800);
    expect(g.json['total_jpy']).toBe(CHAIN_TOTAL_JPY);

    // 支付金额取订单，不是按新价重算；目的国取快照（原地址已删也照常能付）
    const p = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: u1,
      key: 'pay-snap',
      body: { channel: 'mock' },
    });
    expect(p.status).toBe(200);
    expect(p.json['charge']).toEqual({ currency: 'JPY', amount: CHAIN_TOTAL_JPY });

    // 同时：新下单的买家看到的是新价（写侧真的生效，快照不是因为"没改成功"）
    const q = await call(srv, 'POST', '/api/v1/orders/quote', {
      token: u2,
      body: { items: [{ product_id: 'p-knife', qty: 1 }] },
    });
    expect(q.json['items_jpy']).toBe(9900);
  });
});
