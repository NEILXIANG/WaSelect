/**
 * 职责：**编排出来的真并发**（测试审查第二轮补测，AJ-175）——同一张待支付订单上，
 *      "用户取消"与"机构回调落账"两个请求同时到达；关单作业撞上正在被处理的单。
 *      用另一条连接**持行锁**把两个请求都卡在 `for update` 上，确认两者都在排队后放行，
 *      Postgres 按排队顺序授锁——于是"谁先谁后"是确定的，两种先后各跑一次。
 *
 * @why 既有链路用例（order-golden-chain）都是**先后发生**：取消完了回调才到、关单完了钱才到。
 *      它们证明了"后到的那个被正确拒绝"，但没证明"两个同时进来时不会都成功"——
 *      后者才是锁要防的事：没有 `for update` 的话，两边都读到 pending_payment，
 *      结果是"订单已付 + 库存已回补"或"订单已取消 + 支付行 succeeded"这类钱货两错。
 * @why 等待判定看 `pg_stat_activity` 里**卡在行锁上的查询文本**（与 order-failure-consistency 同一手法），
 *      不用 sleep 猜：sleep 在慢机器上会让"排队顺序"变成随机，用例就从"确定性并发"退化成"看运气"。
 *
 * @limitation 一：依赖 Postgres 行锁排队的 FIFO 授予（同一元组上的等待者按到达顺序拿锁）。
 *              @measured 本文件两条先后用例各自稳定通过（本地连跑 5 轮，见 AJ-175 证据）；
 *              若某天 PG 版本改变授锁顺序，这里会红而不是假绿（两种顺序的断言互斥）。
 * @limitation 二：查询文本匹配依赖 SQL 写法（`select status, expires_at from orders` /
 *              `select id, status from orders where id`）——改了 SQL 这里会**超时报错**（不是假绿）。
 *
 * @see app/mark-paid.ts（for update）；app/cancel-order.ts（lockOwnedOrderForCancel）；
 *      adapters/orders.ts lockExpiredPayableOrders（skip locked）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  domainEvents,
  mockCallback,
  orderBody,
  runExpireJob,
  seedChainFixture,
  tokenFor,
  waitUntil,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';

const PAID_LOCK = '%select status, expires_at from orders%for update%';
const CANCEL_LOCK = '%select id, status from orders where id%for update%';

let db: Db;
let srv: ChainServer;
let buyer = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedChainFixture(db);
  buyer = await tokenFor('u-1');
});

async function pendingOrder(key: string): Promise<string> {
  const c = await call(srv, 'POST', '/api/v1/orders', { token: buyer, key, body: orderBody() });
  const orderId = String(c.json['order_id']);
  await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
    token: buyer,
    key: `pay-${key}`,
    body: { channel: 'mock' },
  });
  return orderId;
}

async function waiting(pattern: string): Promise<number> {
  const rows = await db`
    select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`;
  return rows.length;
}

/**
 * 另一条连接持有该订单的行锁，直到 `release()`。
 * ⚠️ 必须等 `ready`（锁**真的拿到了**）再发请求：首版用"没有等待者"当就位信号，那是恒真——
 *    实测关单作业抢在持锁之前跑完、把单关了（本应被 skip locked 跳过），用例红在"expired ≠ pending_payment"。
 */
async function holdOrderLock(
  orderId: string,
): Promise<{ release: () => void; done: Promise<unknown>; end: () => Promise<void> }> {
  const other = testDb();
  let release: () => void = () => {};
  let locked: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    locked = r;
  });
  const done = other.begin(async (tx) => {
    await tx`select id from orders where id = ${orderId} for update`;
    locked();
    await gate;
  });
  await ready;
  return { release, done, end: () => other.end() };
}

async function state(orderId: string) {
  const [o] = await db`select status from orders where id = ${orderId}`;
  const pays = await db`select status from payments where order_id = ${orderId}`;
  const stock = await db`select id, stock from products order by id`;
  const events = await db`select status from order_events where order_id = ${orderId} order by id`;
  return {
    status: String(o?.['status']),
    payments: pays.map((p) => String(p['status'])),
    stock: Object.fromEntries(stock.map((s) => [String(s['id']), Number(s['stock'])])),
    events: events.map((e) => String(e['status'])),
  };
}

describe('同一张待支付单：取消 × 回调 同时到达', () => {
  it('取消先拿到锁 → cancelled、库存回补一次、支付行作废；回调随后按迟到付款拒落账（late_payment + error）', async () => {
    srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder('k-race-c');
      const lock = await holdOrderLock(orderId);
      try {
        const cancel = call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, {
          token: buyer,
          key: 'c-1',
        });
        await waitUntil(async () => (await waiting(CANCEL_LOCK)) === 1, '取消卡在行锁上');
        const paid = mockCallback(srv, db, orderId, { eventId: 'evt-race-c' });
        await waitUntil(async () => (await waiting(PAID_LOCK)) === 1, '回调卡在行锁上');
        lock.release();
        await lock.done;
        const [c, p] = await Promise.all([cancel, paid]);
        expect(c.status).toBe(200);
        expect(p.status).toBe(200); // 业务冲突 2xx：机构重发也不会变
        expect(p.json['ignored']).toBe('late_payment'); // KD-7：已取消的单到账 = 迟到付款
      } finally {
        lock.release();
        await lock.end();
      }
      const s = await state(orderId);
      expect(s.status).toBe('cancelled');
      expect(s.payments).toEqual(['cancelled']);
      expect(s.stock).toEqual({ 'p-cup': 10, 'p-knife': 5 }); // 回补一次，不是两次
      expect(s.events).toEqual(['created', 'pending_payment', 'cancelled']);
      const late = srv.sink.find('callback_late_payment').find((l) => l['order_id'] === orderId);
      expect(late?.level).toBe('error');
      expect((late?.['ctx'] as { from?: string }).from).toBe('cancelled');
      const [wh] = await db`select result from webhook_events where event_id = 'evt-race-c'`;
      expect(wh?.['result']).toBe('late_payment');
      expect(domainEvents(srv.sink, orderId)).not.toContain('order.paid');
    } finally {
      await srv.close();
    }
  });

  it('回调先拿到锁 → paid、支付行 succeeded；取消随后 40902，库存不回补', async () => {
    srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder('k-race-p');
      const lock = await holdOrderLock(orderId);
      try {
        const paid = mockCallback(srv, db, orderId, { eventId: 'evt-race-p' });
        await waitUntil(async () => (await waiting(PAID_LOCK)) === 1, '回调卡在行锁上');
        const cancel = call(srv, 'POST', `/api/v1/orders/${orderId}/cancel`, {
          token: buyer,
          key: 'c-2',
        });
        await waitUntil(async () => (await waiting(CANCEL_LOCK)) === 1, '取消卡在行锁上');
        lock.release();
        await lock.done;
        const [p, c] = await Promise.all([paid, cancel]);
        expect(p.status).toBe(200);
        expect(p.json['ignored']).toBeUndefined();
        expect(c.status).toBe(409);
        expect(c.json['code']).toBe(40902);
      } finally {
        lock.release();
        await lock.end();
      }
      const s = await state(orderId);
      expect(s.status).toBe('paid');
      expect(s.payments).toEqual(['succeeded']);
      expect(s.stock).toEqual({ 'p-cup': 8, 'p-knife': 4 }); // 扣着，没有回补
      expect(s.events).toEqual(['created', 'pending_payment', 'paid']);
      await waitUntil(
        async () => domainEvents(srv.sink, orderId).includes('order.paid'),
        'order.paid',
      );
      expect(domainEvents(srv.sink, orderId)).not.toContain('order.cancelled');
    } finally {
      await srv.close();
    }
  });
});

describe('关单作业撞上正在被处理的单', () => {
  it('行锁被占的单本轮跳过（不等待、不误关），**同批其它到期单照常关**；放行后下一轮再关、库存各回补一次', async () => {
    srv = await buildChainServer(db);
    try {
      const orderId = await pendingOrder('k-race-e');
      // 同批另一张到期单（没人碰它）：区分"跳过被锁的那张"与"整轮失败"（nowait / 报错也会让被锁单保持原状）
      const otherId = await pendingOrder('k-race-e2');
      const future = new Date(Date.now() + 2 * 60 * 60_000);
      const lock = await holdOrderLock(orderId);
      try {
        const t0 = Date.now();
        await runExpireJob(db, srv, future); // 不应被锁卡住
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect((await state(orderId)).status).toBe('pending_payment');
        expect((await state(otherId)).status).toBe('expired');
        expect((await state(otherId)).stock).toEqual({ 'p-cup': 8, 'p-knife': 4 }); // 只回补了 other 那一单
      } finally {
        lock.release();
        await lock.done;
        await lock.end();
      }
      await runExpireJob(db, srv, future);
      const s = await state(orderId);
      expect(s.status).toBe('expired');
      expect(s.stock).toEqual({ 'p-cup': 10, 'p-knife': 5 });
      expect(s.payments).toEqual(['cancelled']);
    } finally {
      await srv.close();
    }
  });
});
