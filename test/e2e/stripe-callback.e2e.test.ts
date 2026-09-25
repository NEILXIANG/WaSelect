/**
 * 职责：Stripe 回调的 L3 端到端——真 HMAC 验签 → 统一分发 → 真库落账。
 *
 * @why 适配器单测证明 verify/parseWebhook 各自正确、契约测试证明两个 Provider 同形状，
 *      但「POST /pay/callback/stripe 打进来 → rawBody → 验签 → 归一化 → apply → 真库」
 *      这条链路此前**零覆盖**（e2e 层只有 mock 通道）——而 Stripe 上线第一天走的正是它。
 *      本文件给两道防线补链路级证明：
 *      ① P2-NEW-1：`checkout.session.completed` + `payment_status='unpaid'` 不落账；
 *      ② 体检 P1-7：dispute 事件反查 PaymentIntent 取 order_id，审计不丢。
 *
 * @limitation 出站调用（dispute 反查 PI）走 fake-stripe-http 替身；验签 / 解析 / 落账全真。
 *             报文形状是本文件内手写的最小形态，**完整形态清单**由 test/factories/stripe.ts
 *             与契约测试互锁守着（两边对不上会先在那里红）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Db } from '../../server/src/adapters/db.js';
import { PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { STRIPE_SIGNATURE_HEADER } from '../../server/src/adapters/payment/stripe-checkout.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import { createFakeStripeHttp } from '../helpers/fake-stripe-http.js';
import {
  E2E_NOW,
  E2E_STRIPE_WHSEC,
  E2E_TRACE as TRACE,
  E2E_USER as USER,
  startSkeleton,
  userToken,
  type SkeletonServer,
} from './harness.js';

let db: Db;
let current: SkeletonServer;
let base = '';
const fakeStripe = createFakeStripeHttp();

/** E2E_NOW 的 epoch 秒：验签容差 ±300s 由装配处的 fixedClock 判定，签名必须落在窗口内。 */
const T_SEC = Math.floor(Date.parse(E2E_NOW) / 1000);

/**
 * 按官方口径构造 `Stripe-Signature` 头：`HMAC-SHA256(whsec, `${t}.${raw}`)` → v1。
 * 独立实现（与被测的 verify 不共享代码）——共享了就成了自证。
 */
function stripeHeader(raw: string, tSec: number = T_SEC): string {
  const v1 = createHmac('sha256', E2E_STRIPE_WHSEC).update(`${tSec}.${raw}`).digest('hex');
  return `t=${tSec},v1=${v1}`;
}

function sessionCompleted(orderId: string, paymentStatus: string, eventId: string): string {
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        object: 'checkout.session',
        id: 'cs_test_e2e_1',
        payment_status: paymentStatus,
        amount_total: 12000,
        currency: 'usd',
        metadata: { order_id: orderId },
        payment_intent: 'pi_e2e_1',
      },
    },
  });
}

function postStripe(raw: string, signature?: string): Promise<Response> {
  return fetch(`${base}${PAY_CALLBACK_PREFIX}/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [STRIPE_SIGNATURE_HEADER]: signature ?? stripeHeader(raw),
      'x-trace-id': TRACE,
    },
    body: raw,
  });
}

async function createOrder(idempotencyKey: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/skeleton/orders`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await userToken()}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-trace-id': TRACE,
    },
    body: '{}',
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { order_id: string }).order_id;
}

async function orderStatus(orderId: string): Promise<string> {
  const rows = await db`select status from orders where id = ${orderId}`;
  return rows[0]?.status as string;
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  current = await startSkeleton(db, { stripeHttp: fakeStripe });
  base = current.base;
}, 30_000);

afterAll(async () => {
  await current.server.close();
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values (${USER}, 'o-e2e') on conflict (id) do nothing`;
});

describe('Stripe 回调全链路（真签名 → 统一分发 → 真库）', () => {
  it('checkout.session.completed(paid) → 订单置 paid，order_events 与 webhook_events 都留痕', async () => {
    const orderId = await createOrder('key-stripe-paid');
    const res = await postStripe(sessionCompleted(orderId, 'paid', 'evt_e2e_paid'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, order_id: orderId });

    expect(await orderStatus(orderId)).toBe('paid');
    const events =
      await db`select status from order_events where order_id = ${orderId} order by id`;
    expect(events.map((r) => r.status)).toEqual(['created', 'paid']);
    const logged =
      await db`select result, provider from webhook_events where event_id = 'evt_e2e_paid'`;
    // result 口径见 ports/webhooks.ts：成功落账写 'paid'（重复回调则是 'paid:already'）
    expect(logged[0]?.result).toBe('paid');
    expect(logged[0]?.provider).toBe('stripe');
  });

  it('completed 但 payment_status=unpaid（异步支付未完成）→ 2xx 收下但**不落账**（P2-NEW-1）', async () => {
    const orderId = await createOrder('key-stripe-unpaid');
    const res = await postStripe(sessionCompleted(orderId, 'unpaid', 'evt_e2e_unpaid'));
    expect(res.status).toBe(200);
    // 归一化成 unknown：收下登记、不落业务状态（F12 状态机接手前的既定语义）
    await expect(res.json()).resolves.toEqual({
      received: true,
      order_id: orderId,
      ignored: 'unknown',
    });

    expect(await orderStatus(orderId)).toBe('created');
    const logged = await db`select result from webhook_events where event_id = 'evt_e2e_unpaid'`;
    expect(logged[0]?.result).toBe('ignored:unknown');
  });

  it('签名被篡改 → 40103，不落账且 webhook_events 零留痕（解析先于登记）', async () => {
    const orderId = await createOrder('key-stripe-forged');
    const raw = sessionCompleted(orderId, 'paid', 'evt_e2e_forged');
    const forged = stripeHeader(raw).replace(/v1=../, 'v1=00');
    const res = await postStripe(raw, forged);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 40103 });

    expect(await orderStatus(orderId)).toBe('created');
    const logged = await db`select event_id from webhook_events where event_id = 'evt_e2e_forged'`;
    expect(logged.length).toBe(0);
  });

  it('charge.dispute.created → 反查 PaymentIntent 拿到 order_id → 登记 ignored:disputed（P1-7）', async () => {
    const orderId = await createOrder('key-stripe-dispute');
    // dispute 对象上没有我们的 metadata（Stripe 不复制），唯一线索是 payment_intent
    fakeStripe.givenPaymentIntent('pi_e2e_dispute', { order_id: orderId });
    const callsBefore = fakeStripe.calls.length;
    const raw = JSON.stringify({
      id: 'evt_e2e_dispute',
      type: 'charge.dispute.created',
      data: {
        object: {
          object: 'dispute',
          id: 'dp_e2e_1',
          payment_intent: 'pi_e2e_dispute',
          amount: 12000,
          currency: 'usd',
        },
      },
    });
    const res = await postStripe(raw);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      received: true,
      order_id: orderId,
      ignored: 'disputed',
    });

    // 真的发生了反查（GET /v1/payment_intents/pi_e2e_dispute）
    const piCalls = fakeStripe.calls
      .slice(callsBefore)
      .filter((c) => c.url.includes('/v1/payment_intents/pi_e2e_dispute'));
    expect(piCalls.length).toBe(1);
    expect(piCalls[0]?.headers?.['authorization']).toBe('Bearer sk_test_e2e_fake');

    const logged = await db`select result from webhook_events where event_id = 'evt_e2e_dispute'`;
    expect(logged[0]?.result).toBe('ignored:disputed');
    expect(await orderStatus(orderId)).toBe('created');
  });
});
