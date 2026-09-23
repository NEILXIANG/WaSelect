/**
 * 职责：行走骨架的 L3 端到端测试（F6c）——一条测试覆盖「请求 → 写库 → 回调 → 状态 → trace 串联」。
 *
 * @why 这是**每个阶段回归的第一条测试**。地基各块分开测全绿，推不出接起来也通：
 *      中间件顺序错一格、事务里用了外层连接、回调拿到已解析的 body——每一块单独看都对。
 *      所以这条测试存在的意义不是"覆盖代码"，而是**证明全栈现在是通的**。
 *
 * 用什么都是真的：真起端口、真库、真事务、真 JWT、真 HMAC 验签、真 pino 输出。
 * 只有支付机构是模拟的（骨架期本来就该是模拟的，F11 才换成 Stripe 真实验签）。
 *
 * @see docs/地基搭建清单.md F6c；server/src/skeleton.ts @limitation
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/db.js';
import { MOCK_CALLBACK_PATH } from '../../server/src/skeleton.js';
import type { MemorySink } from '../helpers/memory-sink.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  E2E_CALLBACK_SECRET as CALLBACK_SECRET,
  E2E_TRACE as TRACE,
  E2E_USER as USER,
  startSkeleton,
  userToken,
  type SkeletonServer,
} from './harness.js';

let db: Db;
let current: SkeletonServer;
let sink: MemorySink;
let base = '';

/** 起一个真实服务；`rawBodyPaths` 可关掉，用于验证"少配一环就断链"。 */
async function startServer(opts: { withRawBody: boolean }): Promise<SkeletonServer> {
  const s = await startSkeleton(db, { withRawBody: opts.withRawBody });
  sink = s.sink;
  base = s.base;
  current = s;
  return s;
}

/** 用给定的 trace 调建单。 */
function createOrder(token: string, idempotencyKey: string, trace = TRACE) {
  return fetch(`${base}/api/v1/skeleton/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-trace-id': trace,
    },
    body: '{}',
  });
}

/** 按骨架的约定给回调报文签名（HMAC-SHA256 hex）。 */
function signedCallback(payload: unknown, secret = CALLBACK_SECRET, trace = TRACE) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return fetch(`${base}${MOCK_CALLBACK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature,
      'x-trace-id': trace,
    },
    body,
  });
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  await startServer({ withRawBody: true });
}, 30_000);

afterAll(async () => {
  await current.server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  // orders.user_id 有外键，每轮都要有这个用户
  await db`insert into users (id, openid) values (${USER}, 'o-e2e') on conflict (id) do nothing`;
  sink.clear();
});

describe('行走骨架：一条链路走到底', () => {
  it('建单 → 回调 → 状态回写 → 全程同一 trace_id', async () => {
    const token = await userToken();

    // ── 1. 建单 ──────────────────────────────────────────────────────────
    const createRes = await createOrder(token, 'key-chain-1');
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get('x-trace-id')).toBe(TRACE);
    const created = (await createRes.json()) as { order_id: string; status: string };
    expect(created.status).toBe('created');

    const orderAfter = await db`select status from orders where id = ${created.order_id}`;
    expect(orderAfter[0]?.status).toBe('created');
    const events1 =
      await db`select status from order_events where order_id = ${created.order_id} order by id`;
    expect(events1.map((r) => r.status)).toEqual(['created']);

    // ── 2. 模拟支付回调（原始报文 + HMAC）─────────────────────────────────
    const cbRes = await signedCallback({ order_id: created.order_id });
    expect(cbRes.status).toBe(200);

    // ── 3. 状态真的回写了，且追加了第二条事件 ──────────────────────────────
    const paid = await db`select status from orders where id = ${created.order_id}`;
    expect(paid[0]?.status).toBe('paid');
    const events2 =
      await db`select status from order_events where order_id = ${created.order_id} order by id`;
    expect(events2.map((r) => r.status)).toEqual(['created', 'paid']);

    // ── 4. 读回接口也能看到新状态 ─────────────────────────────────────────
    const got = await fetch(`${base}/api/v1/skeleton/orders/${created.order_id}`, {
      headers: { authorization: `Bearer ${token}`, 'x-trace-id': TRACE },
    });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({ status: 'paid', trace_id: TRACE });

    // ── 5. 日志：所有带 trace_id 的行都是同一条链，关键事件都落了 ───────────
    const traced = sink.rows().filter((r) => r.trace_id !== undefined);
    expect(traced.length).toBeGreaterThan(0);
    expect([...new Set(traced.map((r) => String(r.trace_id)))]).toEqual([TRACE]);
    expect(sink.find('skeleton_order_created')).toHaveLength(1);
    expect(sink.find('skeleton_payment_callback')).toHaveLength(1);
    // 访问日志（流 C 的请求维度）也在同一条链上
    expect(sink.find('http_request').length).toBeGreaterThanOrEqual(3);
  });

  it('同一个 Idempotency-Key 重放：只建一张单，返回首次结果', async () => {
    const token = await userToken();
    const first = await createOrder(token, 'key-replay-1');
    const firstBody = (await first.json()) as { order_id: string };
    const second = await createOrder(token, 'key-replay-1');
    const secondBody = (await second.json()) as { order_id: string };

    expect(second.status).toBe(201);
    expect(secondBody.order_id).toBe(firstBody.order_id);
    const rows = await db`select id from orders`;
    expect(rows).toHaveLength(1);
  });

  it('未登录不能建单（40101）', async () => {
    const res = await fetch(`${base}/api/v1/skeleton/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k', 'x-trace-id': TRACE },
      body: '{}',
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40101 });
  });

  it('缺少 Idempotency-Key 直接拒绝（防重复下单是硬要求，不是可选项）', async () => {
    const token = await userToken();
    const res = await fetch(`${base}/api/v1/skeleton/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-trace-id': TRACE,
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('骨架专用：模拟支付成功端点同样走 markPaid（与回调共用一套状态回写）', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-sim')).json()) as { order_id: string };

    const res = await fetch(`${base}/api/v1/skeleton/orders/${created.order_id}/simulate-paid`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-trace-id': TRACE },
    });
    expect(res.status).toBe(200);

    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('paid');
    const events = await db`select status from order_events where order_id = ${created.order_id} order by id`;
    expect(events.map((r) => r.status)).toEqual(['created', 'paid']);

    // 之后再走真实回调会被拒（状态已不是 created）——证明两条路径落到同一个状态机约束上
    const cb = await signedCallback({ order_id: created.order_id });
    expect(cb.status).toBe(409);
    await expect(cb.json()).resolves.toMatchObject({ code: 40902 });
  });

  it('回调给了不存在的 order_id → 40400，不能静默吞掉', async () => {
    // @why 机构回调里出现我们没见过的单号是**真实会发生**的（测试环境串号、机构重放历史单）。
    //      吞掉它表现为"钱到了但没单"，且没有任何日志；抛出来至少能被监控看到。
    const res = await signedCallback({ order_id: 'sk-does-not-exist' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 40400 });
    // 一次坏回调不能写出任何事件
    const events = await db`select id from order_events`;
    expect(events).toHaveLength(0);
  });

  it('回调体缺 order_id → 40001（脏输入不能落到 SQL 里）', async () => {
    const res = await signedCallback({ wrong_field: 1 });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('回调验签失败 → 50002 且订单状态不变（错误签名不能改状态）', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-badsig')).json()) as { order_id: string };
    const res = await signedCallback({ order_id: created.order_id }, 'wrong-secret');
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: 50002 });
    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('created');
  });

  it('重复回调（已 paid）→ 40902，不产生第二条 paid 事件', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-dupcb')).json()) as { order_id: string };
    expect((await signedCallback({ order_id: created.order_id })).status).toBe(200);
    const dup = await signedCallback({ order_id: created.order_id });
    expect(dup.status).toBe(409);
    await expect(dup.json()).resolves.toMatchObject({ code: 40902 });
    const events = await db`select status from order_events where order_id = ${created.order_id}`;
    expect(events.filter((r) => r.status === 'paid')).toHaveLength(1);
  });
});

/**
 * 「故意断掉任一一环，测试必须失败」——这里断的是**最容易漏配的那一环**：
 * 回调路由没登记到 `rawBodyPaths`，body 会被 JSON 解析掉，验签必然失败。
 * @why 配错时的症状是"验签永远失败"，而排查时会去怀疑密钥、怀疑机构，
 *      很少有人第一反应是"body 被解析过了"。用一条测试把这个可能性别留给人肉排查。
 */
describe('断链验证：少配一环就必须失败', () => {
  it('回调路由没登记 rawBodyPaths → 验签失败（证明原始报文这一环不可省）', async () => {
    const broken = await startServer({ withRawBody: false });
    const brokenBase = broken.base;
    try {
      const token = await userToken();
      const createRes = await fetch(`${brokenBase}/api/v1/skeleton/orders`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': 'key-broken',
          'x-trace-id': TRACE,
        },
        body: '{}',
      });
      const created = (await createRes.json()) as { order_id: string };

      const body = JSON.stringify({ order_id: created.order_id });
      const signature = createHmac('sha256', CALLBACK_SECRET)
        .update(Buffer.from(body))
        .digest('hex');
      const res = await fetch(`${brokenBase}${MOCK_CALLBACK_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': signature,
          'x-trace-id': TRACE,
        },
        body,
      });
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({ code: 50002 });
    } finally {
      await broken.server.close();
      // 还原到"正常"的服务，避免影响后续用例
      await startServer({ withRawBody: true });
    }
  });
});
