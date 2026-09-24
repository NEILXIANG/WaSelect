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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
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
function createOrder(token: string, idempotencyKey: string, trace = TRACE, body = '{}') {
  return fetch(`${base}/api/v1/skeleton/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-trace-id': trace,
    },
    body,
  });
}

/** 按骨架的约定给回调报文签名（HMAC-SHA256 hex）。 */
function signedCallback(payload: unknown, secret = CALLBACK_SECRET, trace = TRACE) {
  return signedRaw(JSON.stringify(payload), secret, trace);
}

/** 发一段**任意原文**（可故意不是合法 JSON），签名照算——用于验证坏报文的处理。 */
function signedRaw(body: string, secret = CALLBACK_SECRET, trace = TRACE) {
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

    // ── 6. 领域事件：总线真的在流（订阅者把事件落成了日志）────────────────
    //    @why 只测"发布方没报错"是假绿：总线一个订阅者都没有时发布照样成功。
    //         这里断言的是**订阅者确实收到了**，即总线 + 装配 + 发布三方都接上了。
    const business = sink.find('business_event');
    const names = business.map(
      (r) => (r.ctx as { domain_event?: string } | undefined)?.domain_event,
    );
    expect(names).toEqual(['order.created', 'order.paid']);
    expect(business[0]?.order_id).toBe(created.order_id);
  });

  it('幂等重放**不会**重复发领域事件（重放时 handler 不执行 → 没有事件可发）', async () => {
    const token = await userToken();
    const first = await createOrder(token, 'key-event-replay');
    expect(first.status).toBe(201);
    const replay = await createOrder(token, 'key-event-replay');
    expect(replay.status).toBe(201);

    const created2 = sink.find('business_event').filter((r) => {
      const ctx = r.ctx as { domain_event?: string } | undefined;
      return ctx?.domain_event === 'order.created';
    });
    // 两次请求、一张订单 → "订单已创建"只准说一次
    expect(created2).toHaveLength(1);
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

  /**
   * N3（二审 P0-2）：同一个键但请求体**不同** → 40908，而不是错误地返回首次结果。
   * @why skeleton 此前调 withIdempotency 时没传 `request`，指纹恒为 ''，
   *      40908 整条是死代码：客户端复用键的 bug 会被静默吞掉（用户以为下了第二单）。
   */
  it('同一个 Idempotency-Key 但请求体不同 → 40908（N3：指纹校验必须真的接线）', async () => {
    const token = await userToken();
    const first = await createOrder(token, 'key-fp-1', TRACE, '{"qty":1}');
    expect(first.status).toBe(201);
    const second = await createOrder(token, 'key-fp-1', TRACE, '{"qty":99}');
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ code: 40908 });
    // 且绝不能因为第二个请求再建一张单
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
    const events =
      await db`select status from order_events where order_id = ${created.order_id} order by id`;
    expect(events.map((r) => r.status)).toEqual(['created', 'paid']);

    // 之后再走真实回调（状态已是 paid）→ N13/AJ-32：这不是异常，paid:already + info，不再告警
    const cb = await signedCallback({ order_id: created.order_id });
    expect(cb.status).toBe(200);
    await expect(cb.json()).resolves.toMatchObject({ received: true, ignored: 'paid:already' });
    expect(sink.find('paid_already')).toHaveLength(1);
    expect(sink.find('paid_already')[0]?.level).toBe('info');
    expect(sink.find('callback_conflict')).toHaveLength(0);
    // 状态没被二次改动（仍然只有一条 paid 事件）
    const eventsAfter =
      await db`select status from order_events where order_id = ${created.order_id} order by id`;
    expect(eventsAfter.map((r) => r.status)).toEqual(['created', 'paid']);
  });

  /**
   * N4/AJ-32（宽限期内）：回调先到、订单还没落库 → **503 让机构重发**，
   * 且 `processed_at` 保持 NULL（对账信号 + 同一 event_id 重发能补上的前提）。
   * @why 旧行为是一律 2xx + warn，但"可重试"的登记被 200 回应抵消——机构永不重发，
   *      "钱到单未付"只剩一条 warn。宽限期内回 503 是让机构的重发机制替我们兜底。
   */
  it('宽限期内回调先到（order_not_found）→ 503 + processed_at 保持 NULL，不静默吞掉', async () => {
    const res = await signedCallback({ order_id: 'sk-does-not-exist', event_id: 'evt-grace' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    await expect(res.json()).resolves.toMatchObject({
      received: false,
      reason: 'order_not_found_yet',
    });
    expect(sink.find('callback_early')).toHaveLength(1);
    expect(sink.find('callback_early')[0]?.level).toBe('warn');
    // processed_at 必须保持 NULL：这是对账信号，也是"同一 event_id 重发时能补上"的前提
    const rows = await db`select processed_at from webhook_events where event_id = 'evt-grace'`;
    expect(rows[0]?.processed_at).toBeNull();
    /**
     * 租约也必须**交还**（N22 补丁）：这个请求已经结束了，不算"处理中"。
     * 留着租约会让接下来 10 秒内的重投被判成 inflight → 再吃一个 503，
     * 于是"早到 → 重发 → 补上"整条链被租约掐断（本文件的重发补上用例就是这么红的）。
     */
    const lease =
      await db`select processing_until, processing_token from webhook_events where event_id = 'evt-grace'`;
    expect(lease[0]?.processing_until).toBeNull();
    expect(lease[0]?.processing_token).toBeNull();
    // 一次早到的回调不能写出任何业务事件
    const events = await db`select id from order_events`;
    expect(events).toHaveLength(0);
  });

  /**
   * 2026-09-23 自查发现：宽限期算的是"距事件**首次**到达多久"，而首次到达时间是 **DB 时钟**
   * （`received_at` 由 Postgres 的 now() 写入）。用应用的 `Date.now()` 去减它，等于拿两个时钟做减法：
   * 应用时钟快 20 分钟时，一条**刚到**的回调会被判成"超过 15 分钟宽限期" → 2xx 收下 +
   * 落 unmatched、机构不再重发——"钱到单未付"就此静默，且没有任何报错。
   * 判据必须是 DB 自己的 now()（由 claimWebhookEvent 一并返回）。
   */
  it('宽限期判定用 DB 时钟——应用时钟偏快 20 分钟也不许把早到回调判成超期', async () => {
    const OFFSET = 20 * 60 * 1000; // 比默认宽限期（15 分钟）更大
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + OFFSET);
    try {
      const res = await signedCallback({ order_id: 'sk-clock-skew', event_id: 'evt-skew' });
      // 修复前这里会是 200 + unmatched：刚到的回调被误判超期，机构不再重发
      expect(res.status).toBe(503);
      const rows =
        await db`select processed_at, result from webhook_events where event_id = 'evt-skew'`;
      expect(rows[0]?.processed_at).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * N4/AJ-32（超过宽限期）：订单一直没出现 → 2xx 收下（机构不必再重发）+
   * **error 级**告警 + `processed_at` 落 `unmatched:order_not_found`（转入对账视野）。
   * @why 宽限期外还回 503 会让"确实不存在的脏回调"占用机构重发队列；
   *      但"钱到单未付"又绝不能静默——所以这一层用 error 告警 + 对账兜底（F13）。
   */
  it('超过宽限期订单仍不存在 → 2xx + error 告警 + 落 unmatched 待对账', async () => {
    // 独立起一个 graceMs=0 的服务：任何回调都立即"超过宽限期"
    const s = await startSkeleton(db, { withRawBody: true, graceMs: 0 });
    try {
      const raw = JSON.stringify({ order_id: 'sk-never', event_id: 'evt-late' });
      const sig = createHmac('sha256', CALLBACK_SECRET).update(raw).digest('hex');
      const res = await fetch(`${s.base}${MOCK_CALLBACK_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mock-signature': sig,
          'x-trace-id': TRACE,
        },
        body: raw,
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ received: true, ignored: 'unmatched' });
      const alert = s.sink.find('callback_unmatched')[0];
      expect(alert?.level).toBe('error');
      const rows =
        await db`select processed_at, result from webhook_events where event_id = 'evt-late'`;
      expect(rows[0]?.processed_at).not.toBeNull();
      expect(rows[0]?.result).toBe('unmatched:order_not_found');
    } finally {
      await s.server.close();
    }
  });

  /**
   * @why D6 的真实形态：`JSON.parse` 抛的是**我们自己的** SyntaxError，
   *      不带 body-parser 的 `type`/`status` 标记，http.ts 的 isBodyParseError 认不出来
   *      → 折叠成 50000（HTTP 500）。机构收到 500 就会按退避重发 3 天，
   *      而"这段报文永远解析不了"重发也不会变。必须回 4xx。
   */
  it('签名正确但报文是坏 JSON → 40001（4xx，机构不必重试），不是 50000', async () => {
    const res = await signedRaw('{ not json at all');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
    // 且不能占用 5xx 通道
    expect(sink.find('unhandled_error')).toHaveLength(0);
  });

  it('回调体缺 order_id → 40001（脏输入不能落到 SQL 里）', async () => {
    const res = await signedCallback({ wrong_field: 1 });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });

  it('回调验签失败 → 40103（4xx：入站方的问题，不占 5xx），订单状态不变', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-badsig')).json()) as { order_id: string };
    const res = await signedCallback({ order_id: created.order_id }, 'wrong-secret');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40103 });
    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('created');
  });

  /**
   * 重复投递（**同一个 event_id**）→ 在回调层就被识别，不再碰业务。
   *
   * @why 机构的重发是**同一个事件**的同一份报文；把它一路放进业务逻辑再靠状态冲突挡住，
   *      等于每次重发都要走一遍事务、并在日志里留一条 warn——
   *      于是"机构在重发"（完全正常）会把真正的冲突告警淹没。
   *      去重放在最外层，告警才有信噪比。
   */
  it('同一 event_id 重投 → duplicate:true，业务层不再执行', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-dupcb')).json()) as { order_id: string };
    const payload = { order_id: created.order_id, event_id: 'evt-dup-1' };
    expect((await signedCallback(payload)).status).toBe(200);

    const dup = await signedCallback(payload);
    expect(dup.status).toBe(200);
    await expect(dup.json()).resolves.toMatchObject({ received: true, duplicate: true });
    // 业务层根本没被调用：没有冲突告警、没有第二条 paid 事件
    expect(sink.find('callback_conflict')).toHaveLength(0);
    expect(sink.find('webhook_duplicate')).toHaveLength(1);
    const events = await db`select status from order_events where order_id = ${created.order_id}`;
    expect(events.filter((r) => r.status === 'paid')).toHaveLength(1);
  });

  /** 不同的事件（不同 event_id）落在已支付的订单上 → N13：paid:already + info，不是异常。 */
  it('另一个事件（不同 event_id）落在已支付订单 → paid:already + info，不产生第二条 paid 事件', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-conflict')).json()) as {
      order_id: string;
    };
    expect((await signedCallback({ order_id: created.order_id, event_id: 'evt-a' })).status).toBe(
      200,
    );
    const second = await signedCallback({ order_id: created.order_id, event_id: 'evt-b' });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      received: true,
      ignored: 'paid:already',
    });
    expect(sink.find('paid_already')).toHaveLength(1);
    expect(sink.find('paid_already')[0]?.level).toBe('info');
    expect(sink.find('callback_conflict')).toHaveLength(0);
    const events = await db`select status from order_events where order_id = ${created.order_id}`;
    expect(events.filter((r) => r.status === 'paid')).toHaveLength(1);
    // 登记结果也要是 paid:already（对账时能区分"正常重发"与"真冲突"）
    const rows = await db`select result from webhook_events where event_id = 'evt-b'`;
    expect(rows[0]?.result).toBe('paid:already');
  });

  /**
   * 回调比订单先到 → 宽限期内 503（机构会重发），**同一 event_id 重发时必须能再处理一次**。
   * @why 这是"去重 vs 正确性"冲突时的裁决场景：去重只是优化，
   *      "钱到了但订单没变成 paid"是事故。503 期间 processed_at 保持 NULL，
   *      重发时 claim 得到 `retry`，于是业务再跑一遍（AJ-32 双层结构的第一层）。
   */
  it('回调先到（宽限期内 503）→ 订单出现后同一个 event_id 重发时能补上', async () => {
    const token = await userToken();
    // 先发一个指向尚未创建订单的回调 → 宽限期内 503
    const early = await signedCallback({ order_id: 'sk-later', event_id: 'evt-early' });
    expect(early.status).toBe(503);
    await expect(early.json()).resolves.toMatchObject({
      received: false,
      reason: 'order_not_found_yet',
    });

    // 订单随后建好
    const created = (await (await createOrder(token, 'key-late')).json()) as { order_id: string };
    // 机构重发**同一个** event_id（这次带上真实单号）
    const retry = await signedCallback({ order_id: created.order_id, event_id: 'evt-early' });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ received: true });
    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('paid');
  });
});

/**
 * 资源归属（D7）：`order_id` 是标识符，不是能力凭证。
 *
 * @why 骨架的 GET 与 simulate-paid 此前只鉴权"你是登录用户"，不校验"这张单是不是你的"。
 *      后果有两层：① 别人的单号能读到地址/金额快照；② 骨架期更严重——
 *      simulate-paid 能把**别人**的单直接改成已支付。
 *      UUID 不可猜 ≠ 不可泄漏：单号会出现在日志、邮件、客服对话、浏览器历史里。
 * @why 归属不符一律 **404 而不是 403**：403 会确认"这个 id 存在"，
 *      于是攻击者可以用 403/404 的差异枚举出全站有效订单号（存在性探测）。
 *      代价是真正的用户看到"订单不存在"而不是"没权限"，排障时略难——
 *      用**日志**区分（details 带 `owner_mismatch`），不靠响应体区分。
 */
describe('资源归属：order_id 不是能力凭证（D7）', () => {
  const OTHER = 'u-e2e-other';

  beforeEach(async () => {
    // orders.user_id 有外键，第二个用户也要先存在
    await db`insert into users (id, openid) values (${OTHER}, 'o-e2e-other') on conflict (id) do nothing`;
  });

  it('别人读我的单 → 40400（不是 403）', async () => {
    const mine = await userToken();
    const other = await userToken(OTHER);
    const created = (await (await createOrder(mine, 'key-own-get')).json()) as { order_id: string };

    const res = await fetch(`${base}/api/v1/skeleton/orders/${created.order_id}`, {
      headers: { authorization: `Bearer ${other}`, 'x-trace-id': TRACE },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 40400 });
  });

  it('别人把我的单改成已支付 → 40400，订单状态与事件都不动', async () => {
    const mine = await userToken();
    const other = await userToken(OTHER);
    const created = (await (await createOrder(mine, 'key-own-pay')).json()) as { order_id: string };

    const res = await fetch(`${base}/api/v1/skeleton/orders/${created.order_id}/simulate-paid`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other}`, 'x-trace-id': TRACE },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 40400 });

    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('created');
    expect(await db`select id from order_events where status = 'paid'`).toHaveLength(0);
  });

  it('归属不符只在日志里可辨（响应体不能泄漏这个区别）', async () => {
    const mine = await userToken();
    const other = await userToken(OTHER);
    const created = (await (await createOrder(mine, 'key-own-log')).json()) as { order_id: string };

    await fetch(`${base}/api/v1/skeleton/orders/${created.order_id}`, {
      headers: { authorization: `Bearer ${other}`, 'x-trace-id': TRACE },
    });

    const rejected = sink.find('request_rejected').at(-1);
    expect(rejected?.err_code).toBe(40400);
    // details 只进日志，不进响应体——这是"用日志区分 404 的两种成因"的兑现
    expect(JSON.stringify(rejected?.details ?? {})).toContain('owner_mismatch');
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
      // 验签失败 = 40103（D6 后是 4xx）；这里断言的是"验签没过"，不是具体状态码
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 40103 });
    } finally {
      await broken.server.close();
      // 还原到"正常"的服务，避免影响后续用例
      await startServer({ withRawBody: true });
    }
  });
});

/**
 * N22（二审 P0-3）：同一个 event_id 的**并发**重复投递，只允许一个请求进入业务。
 *
 * @why 三态时期（new/handled/retry）把"正在处理"和"崩溃遗留"压成同一个 `retry`：
 *      库里两者长得一模一样（`processed_at IS NULL`），于是并发的第二次投递也会去处理。
 *      订单状态有 `for update` 兜底不会写错，但**事件行的 result 会被后写完的覆盖**——
 *      而这张表存在的唯一理由就是"这条回调到底怎么处理的"要说得清（举证）。
 *
 * @why 这道闸门是**编排**出来的，不是 `Promise.all` 碰运气。
 *      AJ-37 的硬要求：竞态窗口必须被编排，靠 sleep 或并发碰运气的测试
 *      在慢机器上会假绿、在快机器上会假红，二者都等于没测。
 *      办法是在 `db.begin`（markPaid 的事务入口）上装一道闸：A 进闸即停，
 *      我们从容地发 B、断言它的响应，再放行 A。窗口 100% 落在我们要的地方。
 * @tradeoff 闸门打在 `begin` 上意味着"处理中段"由事务入口近似——
 *          好处是稳定；代价是它不覆盖"claim 之后、事务之前"那段（那段没有 IO，窗口极窄，
 *          由 webhooks.db.test.ts 用直接调库的方式覆盖）。
 */
describe('N22：并发重复投递只有一个持有者（processing_until 租约 + 栅栏令牌）', () => {
  /** 在 `db.begin` 上装一道可控闸门：armed 之后第一个事务会停在闸内，直到 release()。 */
  function gatedDb(real: Db): {
    db: Db;
    arm: () => void;
    entered: Promise<void>;
    release: () => void;
  } {
    let armed = false;
    let enteredResolve: () => void = () => undefined;
    let releaseResolve: () => void = () => undefined;
    const entered = new Promise<void>((r) => {
      enteredResolve = r;
    });
    const release = new Promise<void>((r) => {
      releaseResolve = r;
    });
    const gated = new Proxy(real, {
      get(target, prop) {
        if (prop === 'begin' && armed) {
          return async (fn: unknown) => {
            enteredResolve();
            await release;
            return (target.begin as (f: unknown) => unknown)(fn);
          };
        }
        const v: unknown = Reflect.get(target, prop);
        // 绑回真实对象：postgres.js 的方法靠内部字段工作，this 必须是 target 而不是代理
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return {
      db: gated,
      arm: () => {
        armed = true;
      },
      entered,
      release: () => releaseResolve(),
    };
  }

  it('同一 event_id 并发重投：一个处理、另一个 503 already_processing，业务只跑一次', async () => {
    const gate = gatedDb(db);
    const s = await startSkeleton(gate.db, { withRawBody: true });
    try {
      const token = await userToken();
      const created = (await (
        await fetch(`${s.base}/api/v1/skeleton/orders`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': 'key-n22',
            'x-trace-id': TRACE,
          },
          body: '{}',
        })
      ).json()) as { order_id: string };

      const raw = JSON.stringify({ order_id: created.order_id, event_id: 'evt-concurrent' });
      const signature = createHmac('sha256', CALLBACK_SECRET).update(raw).digest('hex');
      const post = () =>
        fetch(`${s.base}${MOCK_CALLBACK_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mock-signature': signature,
            'x-trace-id': TRACE,
          },
          body: raw,
        });

      gate.arm();
      const first = post();
      // A 已进闸（持有租约、业务尚未写完）——此刻发 B，必然撞上"处理中"
      await gate.entered;

      const second = await post();
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('10');
      await expect(second.json()).resolves.toMatchObject({
        received: false,
        reason: 'already_processing',
      });

      // B 绝不能顺手把业务做了：此时还没有任何 paid 事件，事件行也没封口
      expect(await db`select id from order_events where status = 'paid'`).toHaveLength(0);
      const mid = await db`
        select processed_at, processing_until > now() as lease_live
          from webhook_events where event_id = 'evt-concurrent'
      `;
      expect(mid[0]?.processed_at).toBeNull();
      expect(mid[0]?.lease_live).toBe(true);
      expect(s.sink.find('webhook_inflight')).toHaveLength(1);

      // 放行 A
      gate.release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);

      // 业务只跑了一次：一条 paid 事件，事件行封口且租约已交还
      const events =
        await db`select status from order_events where order_id = ${created.order_id} order by id`;
      expect(events.map((r) => r.status)).toEqual(['created', 'paid']);
      const rows = await db`
        select result, processed_at, processing_until
          from webhook_events where event_id = 'evt-concurrent'
      `;
      expect(rows[0]?.result).toBe('paid');
      expect(rows[0]?.processed_at).not.toBeNull();
      expect(rows[0]?.processing_until).toBeNull();
      // 没有"结果没写成"的告警：A 是唯一持有者，令牌对得上
      expect(s.sink.find('webhook_result_not_written')).toHaveLength(0);
    } finally {
      gate.release();
      await s.server.close();
    }
  });

  /**
   * 崩溃遗留 → 下一次投递**必须能接管**。
   * @why 这是租约机制的两面之一：上面那条证明"活的持有者不被抢"，
   *      这条证明"死了的持有者不挡路"。只测前者的租约会把崩溃的回调永久卡死——
   *      那正是 N22 想修的问题换了个方向复发。
   * @why 用**过期租约 + processed_at IS NULL** 精确模拟崩溃：进程死了，
   *      行留在那儿，租约到期后自然可被接管（不需要心跳，见 webhooks.ts @limitation）。
   */
  it('租约过期（上次处理崩了）→ 下一次投递接管并补上，订单最终 paid', async () => {
    const token = await userToken();
    const created = (await (await createOrder(token, 'key-n22-crash')).json()) as {
      order_id: string;
    };
    // 手工造一行"崩溃遗留"：登记过、没处理完、租约已过期
    await db`
      insert into webhook_events (provider, event_id, event_type, payload_hash,
                                  processing_until, processing_token)
      values ('mock', 'evt-crashed', 'payment.succeeded', 'deadbeef',
              now() - interval '1 second', gen_random_uuid())
    `;

    const res = await signedCallback({ order_id: created.order_id, event_id: 'evt-crashed' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true });

    const rows = await db`select status from orders where id = ${created.order_id}`;
    expect(rows[0]?.status).toBe('paid');
    const w = await db`
      select result, processed_at from webhook_events where event_id = 'evt-crashed'
    `;
    expect(w[0]?.result).toBe('paid');
    expect(w[0]?.processed_at).not.toBeNull();
  });
});
