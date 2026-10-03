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
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_SOURCE_TAG,
} from '../../server/src/adapters/payment/stripe-checkout.js';
import { recordPaymentIntent } from '../../server/src/app/payment-intent.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import { createFakeStripeHttp } from '../helpers/fake-stripe-http.js';
import { seedCreatedOrder } from '../helpers/seed-order.js';
import {
  E2E_NOW,
  E2E_STRIPE_WHSEC,
  E2E_TRACE as TRACE,
  E2E_USER as USER,
  startApp,
  type E2EServer,
} from './harness.js';

let db: Db;
let current: E2EServer;
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

/** 同上，但对**原始字节**签名（报文含非法 UTF-8 时字符串版会把字节替换成 U+FFFD，签的就不是发的）。 */
function stripeHeaderBytes(raw: Buffer, tSec: number = T_SEC): string {
  const v1 = createHmac('sha256', E2E_STRIPE_WHSEC)
    .update(Buffer.concat([Buffer.from(`${tSec}.`, 'utf8'), raw]))
    .digest('hex');
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
        // ⚠️ 必须带本系统标记（AJ-310）：`create()` 写进 Session 的是 `order_id` + `source`
        //    **两键**，只写 order_id 的样本会被归属判定判成"非本系统的钱" → 不落账。
        metadata: { order_id: orderId, source: STRIPE_SOURCE_TAG },
        payment_intent: 'pi_e2e_1',
      },
    },
  });
}

function postStripe(raw: string | Buffer, signature?: string): Promise<Response> {
  return fetch(`${base}${PAY_CALLBACK_PREFIX}/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [STRIPE_SIGNATURE_HEADER]:
        signature ?? (typeof raw === 'string' ? stripeHeader(raw) : stripeHeaderBytes(raw)),
      'x-trace-id': TRACE,
    },
    body: raw,
  });
}

/**
 * 插库造一张在途单（created）：本文件的焦点是**回调链路**（验签 → 分发 → 落账），
 * 建单链路本身由 order-routes.db.test 覆盖（seed-order helper 的 @why）。
 */
function seedOrder(orderId: string): Promise<string> {
  return seedCreatedOrder(db, orderId, { userId: USER });
}

async function orderStatus(orderId: string): Promise<string> {
  const rows = await db`select status from orders where id = ${orderId}`;
  return rows[0]?.status as string;
}

/**
 * 登记"这张单要在 Stripe 上收 120 USD（12,000 分）"（走真函数）。
 *
 * @why 三审 S1②：落账现在必须绑定通道与金额。这里的三个值必须与报文一致
 *      （`amount_total: 12000` / `currency: 'usd'` / `id: 'cs_test_...'`），
 *      ——**故意**不在测试里放宽：放宽就等于假装在验一条生产上根本不存在的路径。
 */
function seedStripePayment(orderId: string, sessionId = 'cs_test_e2e_1'): Promise<void> {
  return recordPaymentIntent(db, {
    id: `pay-${orderId}`,
    orderId,
    provider: 'stripe',
    providerRef: sessionId,
    chargeCurrency: 'USD',
    chargeAmount: 12000,
  });
}

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  current = await startApp(db, { stripeHttp: fakeStripe });
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
    const orderId = await seedOrder('o-stripe-paid');
    await seedStripePayment(orderId);
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
    // 接缝：paid_at 来自装配处注入的时钟（E2E_NOW），不是 SQL now()——
    // 行时间、order_events.at 与领域事件三者同源（三审 mark-paid 修正的链路级证明）
    const paid = await db`select paid_at from orders where id = ${orderId}`;
    expect((paid[0]?.paid_at as Date).toISOString()).toBe(E2E_NOW);
    const evt =
      await db`select at from order_events where order_id = ${orderId} and status = 'paid'`;
    expect((evt[0]?.at as Date).toISOString()).toBe(E2E_NOW);
  });

  it('报文含 \\u 转义与多字节日文，签名按发出的原始字节 → 200 落账（rawBody 必须是真字节，不能是 JSON 重序列化）', async () => {
    // @why `JSON.stringify(JSON.parse(body))` 会把 `\u30c6` 展开成原字符、丢掉空白——重序列化后的
    //      字节与机构签的不同，验签必然失败。这条钉住的是 http 层 rawBody 中间件与适配器验签的接缝。
    const orderId = await seedOrder('o-stripe-bytes');
    await seedStripePayment(orderId, 'cs_test_e2e_bytes');
    const raw =
      '{ "id": "evt_e2e_bytes", "type": "checkout.session.completed",  "data": { "object": {' +
      '"object": "checkout.session", "id": "cs_test_e2e_bytes", "payment_status": "paid",' +
      '"amount_total": 12000, "currency": "usd", "customer_details": { "name": "\\u30c6\\u30b9\\u30c8 太郎" },' +
      // ⚠️ 同上：必须带本系统标记（AJ-310），否则归属判定把它判成"非本系统的钱"
      `"metadata": { "order_id": "${orderId}", "source": "${STRIPE_SOURCE_TAG}" },` +
      `"payment_intent": "pi_e2e_bytes" } } }`;
    const res = await postStripe(Buffer.from(raw, 'utf8'));
    expect(res.status).toBe(200);
    expect(await orderStatus(orderId)).toBe('paid');
  });

  it('原始字节含非法 UTF-8（签名按字节正确）→ 40001 坏报文，而不是 40103 验签失败；零留痕', async () => {
    // @why 三审 S4：验签若先 `toString('utf8')` 再 HMAC，非法字节被换成 U+FFFD → 签名不匹配 → 40103，
    //      排障方向就错了（以为密钥错）。按字节验签后，坏的只是 JSON，应落 40001（4xx，机构不必重试）。
    const orderId = await seedOrder('o-stripe-badutf8');
    const raw = Buffer.concat([
      Buffer.from(sessionCompleted(orderId, 'paid', 'evt_e2e_badutf8'), 'utf8'),
      Buffer.from([0xff]),
    ]);
    const res = await postStripe(raw);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 40001 });
    expect(await orderStatus(orderId)).toBe('created');
    const logged = await db`select event_id from webhook_events where event_id = 'evt_e2e_badutf8'`;
    expect(logged.length).toBe(0);
  });

  it('completed 但 payment_status=unpaid（异步支付未完成）→ 2xx 收下但**不落账**（P2-NEW-1）', async () => {
    const orderId = await seedOrder('o-stripe-unpaid');
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
    const orderId = await seedOrder('o-stripe-forged');
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
    const orderId = await seedOrder('o-stripe-dispute');
    // dispute 对象上没有我们的 metadata（Stripe 不复制），唯一线索是 payment_intent
    // B5 / AJ-198：带上本系统标记，否则会被判成"账户里非本系统收的款"而不再链回订单
    fakeStripe.givenPaymentIntent('pi_e2e_dispute', {
      order_id: orderId,
      source: STRIPE_SOURCE_TAG,
    });
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

/**
 * 接缝：回调 → 落账（事务提交）→ 提交后分发 → **async 订阅者失败**。
 * @why 三审 P2-1：`EventHandler` 原先只捕获同步异常，async 订阅者的 rejection 逃出总线后
 *      被进程级 unhandledRejection 当"漏 catch 的 bug"→ fatal 停机。单测钉住了总线本身；
 *      这里证明的是**整条链**：HTTP 回调照样 2xx、订单照样 paid、失败只记一行日志、进程不退出。
 */
describe('提交后分发：async 订阅者失败不影响回调与落账（三审 P2-1 链路级证明）', () => {
  let srv: E2EServer;
  const savedBase = () => base;
  let previousBase = '';
  let calls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    previousBase = savedBase();
    srv = await startApp(db, {
      stripeHttp: fakeStripe,
      subscribe: (events) => {
        // 典型形态：通知 / 发货指令这类网络调用天然是 async；失败时它抛的是 rejected Promise
        events.subscribe('order.paid', async () => {
          calls += 1;
          await Promise.resolve();
          throw new Error('notify-service-down');
        });
      },
    });
    base = srv.base;
    process.on('unhandledRejection', onUnhandled);
  }, 30_000);

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    base = previousBase;
    await srv.server.close();
  });

  it('订阅者 reject → 回调仍 200、订单 paid、记 domain_event_subscriber_failed、无 unhandledRejection', async () => {
    const orderId = await seedOrder('o-stripe-async-sub');
    await seedStripePayment(orderId);
    const res = await postStripe(sessionCompleted(orderId, 'paid', 'evt_e2e_async_sub'));
    expect(res.status).toBe(200);
    expect(await orderStatus(orderId)).toBe('paid');
    expect(calls).toBe(1);
    // rejection 是异步到达的：让微任务与 unhandledRejection 的投递窗口都走完
    await new Promise((r) => setTimeout(r, 50));
    const failed = srv.sink.find('domain_event_subscriber_failed');
    expect(failed.length).toBe(1);
    expect(JSON.stringify(failed[0])).toContain('notify-service-down');
    expect(unhandled).toEqual([]);
  });
});
