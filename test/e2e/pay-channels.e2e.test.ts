/**
 * 职责：F11 支付路由的 L3 端到端（真库 + 真端口 + 真注册表 + 真 mock Provider）。
 *
 * @why 单元层能证明"路由把注册表接对了"，但证明不了**下线语义在真实链路里成立**——
 *      "已下线通道的回调仍要落账"依赖真库的登记 / 租约 / 事务共同正确，
 *      用桩存储测出来的绿不足以支撑"钱会落账"这个结论。
 *
 * @why 这两条是本单元最该被钉住的契约：
 *      ① `GET /pay/channels` 是前端入口的唯一来源——下线通道必须**自动消失**；
 *      ② 同一下线通道的**在途回调仍必须落账**——否则等于吞掉一批已付款订单。
 *      两者合起来才是"可插拔"；只做①不做②是本项目最不该犯的那一类错。
 *
 * @limitation 用 `mock` 通道（真 HMAC 验签）代表"任一通道"：
 *              这条路径与真实机构唯一的区别是验签算法，而那部分由
 *              `stripe-checkout.unit.test.ts` 与契约测试覆盖。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { PAY_CALLBACK_PREFIX, PAY_CHANNELS_PATH } from '../../server/src/app/pay-routes.js';
import { recordPaymentIntent } from '../../server/src/app/payment-intent.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  E2E_CALLBACK_SECRET as CALLBACK_SECRET,
  E2E_TRACE as TRACE,
  E2E_USER as USER,
  signMockCallback,
  startSkeleton,
  userToken,
  type SkeletonServer,
} from './harness.js';

let db: Db;
let current: SkeletonServer;
let base = '';

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await current.server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values (${USER}, 'o-e2e') on conflict (id) do nothing`;
});

/**
 * 起一个服务；`mockEnabled=false` 即"该通道已下线"。
 *
 * @why 默认值写成 `true` 而不是让 `mockEnabled` 可选再 `?? true`：
 *      本仓库开了 `exactOptionalPropertyTypes`，`boolean | undefined` 不能直接塞进 `boolean?`，
 *      而"没给就是启用"这件事本来就该由**这一处默认参数**表达，
 *      不该让下游再兜一次 `??`——兜两次就有两个地方可以说"默认是启用"，会漂。
 */
async function start(opts: { mockEnabled: boolean } = { mockEnabled: true }): Promise<void> {
  if (current !== undefined) await current.server.close();
  const s = await startSkeleton(db, { mockEnabled: opts.mockEnabled });
  current = s;
  base = s.base;
}

function channels(q: string): Promise<Response> {
  return fetch(`${base}${PAY_CHANNELS_PATH}?${q}`);
}

async function createOrder(idempotencyKey: string): Promise<string> {
  const token = await userToken();
  const res = await fetch(`${base}/api/v1/skeleton/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-trace-id': TRACE,
    },
    body: '{}',
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { order_id: string }).order_id;
}

/** 骨架单一律 1,000 円（与 skeleton.e2e 同一口径）；回调与 payments 行必须都用它（三审 U1）。 */
const CHARGE = { currency: 'JPY', amountMinor: 1000 };

/**
 * 登记"发起过支付"（走真函数）：三审 S1② 之后，没有 `payments` 行的订单
 * **任何**通道的回调都不落账——这条事实必须先摆出来，否则测的就不是生产行为了。
 */
function seedPayment(orderId: string, provider = 'mock'): Promise<void> {
  return recordPaymentIntent(db, {
    id: `pay-${orderId}`,
    orderId,
    provider,
    providerRef: 'cs_1',
    chargeCurrency: CHARGE.currency,
    chargeAmount: CHARGE.amountMinor,
  });
}

/** 按 mock 通道的约定发一条"支付成功"回调。 */
function payCallback(orderId: string, eventId = 'evt-1'): Promise<Response> {
  const body = JSON.stringify({
    event_id: eventId,
    type: 'payment.succeeded',
    order_id: orderId,
    provider_ref: 'cs_1',
    amount_minor: CHARGE.amountMinor,
    currency: CHARGE.currency,
  });
  return fetch(`${base}${PAY_CALLBACK_PREFIX}/mock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signMockCallback(body, CALLBACK_SECRET),
      'x-trace-id': TRACE,
    },
    body,
  });
}

describe('GET /pay/channels（前端入口的唯一来源）', () => {
  it('返回可用通道的**视图**：只有 channel / entryMode / label，不带任何机构配置', async () => {
    await start();
    const res = await channels('country=US&currency=JPY&amount_jpy=10000');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      // icon 是契约 ChannelView 的字段（D-56），生产装配（CHANNEL_DEFAULTS）真实返回它——
      // harness 曾经漏配导致本条在与生产不一致的形状上全绿（2026-09-25 链路测试抓出）
      items: [{ channel: 'mock', entryMode: 'in_app', icon: 'flask', label: '模拟支付' }],
    });
  });

  it('条件不匹配（国家/币种）→ 空列表，而不是报错（前端据此显示"暂无可用支付方式"）', async () => {
    await start();
    // mock 通道的能力只声明了 JPY
    const res = await channels('country=US&currency=USD&amount_jpy=10000');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it('参数不合法 → 40001（三个参数都必填：不给默认值 = 不把国家写死在服务端）', async () => {
    await start();
    const res = await channels('country=US&currency=JPY');
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
  });
});

describe('🔒 下线语义：入口消失，但在途回调仍要落账', () => {
  it('通道下线 → 列表里没有它（前端入口自动消失，不发版）', async () => {
    await start({ mockEnabled: false });
    const res = await channels('country=US&currency=JPY&amount_jpy=10000');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  /**
   * @why 这是本单元**最重要**的一条：用 `get()` 接回调的话，
   *      "通道刚被下线"那一刻正好有一批在途支付，它们的回调会被 40001 挡在门外，
   *      表现为"用户付了钱、订单永远停在未支付、货不发、也没有告警"。
   *      这里用**真库**证明：下线只影响新单，不影响已发生支付落账。
   */
  it('同一条已下线通道的回调**照样置为 paid**（禁用只阻止新单）', async () => {
    await start({ mockEnabled: false });
    // 前置：这张单是在通道下线**之前**建的（在途支付），所以它登记过支付期望
    const orderId = await createOrder('key-disabled-channel');
    await seedPayment(orderId);

    const res = await payCallback(orderId, 'evt-after-disabled');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, order_id: orderId });

    const rows = await db`select status from orders where id = ${orderId}`;
    expect(rows[0]?.status).toBe('paid');
    const events =
      await db`select status from order_events where order_id = ${orderId} order by id`;
    expect(events.map((r) => r.status)).toEqual(['created', 'paid']);
  });

  it('未注册的通道（配置里没有）→ 40001，订单状态不变（验不了签必须响亮失败）', async () => {
    await start();
    const orderId = await createOrder('key-ghost');
    const res = await fetch(`${base}${PAY_CALLBACK_PREFIX}/ghost`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-signature': 'whatever' },
      body: JSON.stringify({ type: 'payment.succeeded', order_id: orderId }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
    const rows = await db`select status from orders where id = ${orderId}`;
    expect(rows[0]?.status).toBe('created');
  });
});

describe('统一分发：非 succeeded 的结果不落账', () => {
  it('checkout 过期（payment.expired）→ 2xx 收下但订单**不**变 paid（F12 状态机接手前只登记）', async () => {
    await start();
    const orderId = await createOrder('key-expired');
    const body = JSON.stringify({
      event_id: 'evt-expired',
      type: 'payment.expired',
      order_id: orderId,
      provider_ref: 'cs_1',
    });
    const res = await fetch(`${base}${PAY_CALLBACK_PREFIX}/mock`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': signMockCallback(body, CALLBACK_SECRET),
      },
      body,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      received: true,
      order_id: orderId,
      ignored: 'expired',
    });
    const rows = await db`select status from orders where id = ${orderId}`;
    expect(rows[0]?.status).toBe('created');
    // 登记行必须留下痕迹：否则"机构发了而我们没反应"无从查起
    const logged = await db`select result from webhook_events where event_id = ${'evt-expired'}`;
    expect(logged[0]?.result).toBe('ignored:expired');
  });
});
