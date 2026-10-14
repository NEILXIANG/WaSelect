/**
 * 职责：**Stripe 通道的整链**（测试审查第二轮补测，AJ-175）——生产装配（`mountAllRoutes`）+ 真库，
 *      只有"Stripe 的 HTTP 服务器"是替身：
 *      建单 → 选 stripe → 短链 → 302 到托管页 → 签名回调 `checkout.session.completed` → paid
 *      → 管理端退款（会话号反查 PI → 退款）→ refunded；以及拒付开案/结案经真 HTTP 回调改变退款闸门。
 *
 * @why 此前 Stripe 的每一段都有测试，但**没有一条把它们拼起来**：适配器单测喂的是手写 `pi_1`、
 *      e2e 回调测试直接往库里种支付行、退款路由测试走 mock 通道——于是"退款拿会话号当 PI 传"（KD-11）
 *      这种只在**拼起来**时才出现的缺陷，所有层都是绿的。整链的输入全部来自上一步的**真实输出**
 *      （会话号来自 create 的响应、回调金额来自 payments 行、退款单号来自退款响应），不手写中间值。
 * @why 出站 HTTP 走生产的 `createFetchClient`（超时/重试/熔断都是真的），只在 `fetch` 这一层把
 *      `https://api.stripe.com/` 的请求转给有脾气的替身（同键异参报错、退款只认 PI，见 fake-stripe-http.ts）；
 *      其它地址（测试自己打服务端）原样放行。
 *
 * @limitation 一：签名用本文件内独立实现的 HMAC（不复用被测的 verify）；时间取真实当前时刻，
 *              因为 `mountAllRoutes` 写死 systemClock（chain-server @limitation 一）。
 * @limitation 二：替身不模拟 Stripe 的 24 小时幂等窗口与 async 支付方式；
 *              "机构已执行但响应丢失"用 `dropResponses` 模拟（请求照常交给替身执行，然后抛网络错误）。
 * @limitation 三：真 Stripe 的行为（状态码、报文细节）仍以文档为据（@measured 见替身文件头），
 *              上线前必须用 sk_test 在 Stripe 测试模式真打一轮（见报告"测不了的项"）。
 *
 * @see test/helpers/fake-stripe-http.ts；server/src/adapters/payment/stripe-checkout.ts；
 *      docs/自主决策记录.md AJ-175；docs/测试策略与验证门禁.md §3.3
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  createFakeStripeHttp,
  type FakeStripeHttp,
} from '../../../test/helpers/fake-stripe-http.js';
import {
  buildChainServer,
  call,
  mockCallback,
  orderBody,
  CHAIN_ITEMS,
  seedChainFixture,
  tokenFor,
  waitUntil,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { PAY_CALLBACK_PREFIX } from './pay-routes.js';
import { executeRefund } from './refund-execution.js';
import { createEventBus } from '../adapters/event-bus.js';
import type { PaymentProvider } from '../ports/payment.js';
import {
  CHARGE_CURRENCY_ORDER,
  chargeOptions,
  payNotice,
} from '../../../miniprogram/utils/pay-plan.js';
import { PAY_LINK_PREFIX } from './pay-link-routes.js';
import {
  STRIPE_MIN_SESSION_TTL_SEC,
  STRIPE_SESSION_MARGIN_SEC,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_SOURCE_TAG,
} from '../adapters/payment/stripe-checkout.js';

const WHSEC = 'whsec_chain_test_secret';
const CHECKOUT_BASE = 'https://checkout.example.test';
const STRIPE_API = 'https://api.stripe.com/';

let db: Db;
let srv: ChainServer;
let fake: FakeStripeHttp;
/** 路径片段 → 还要"执行后丢响应"的次数（模拟机构已执行、我们没收到答复）。 */
const dropResponses = new Map<string, number>();
const realFetch = globalThis.fetch;

/**
 * 取字符串 body（Stripe 这一侧恒为 form-urlencoded）。
 * @why 端口 `HttpRequest.body` 自 B1 起是 `string | Buffer`（对象存储要发二进制），
 *      这里显式收窄：非字符串按空串处理，随后的 `form.get(...)` 断言会红——
 *      比 `String(body)` 好，后者会把图片字节变成乱码而断言照样跑。
 */
function textBodyLike(body: string | Buffer | undefined): string {
  return typeof body === 'string' ? body : '';
}

function headersOf(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

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
  fake = createFakeStripeHttp();
  dropResponses.clear();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(STRIPE_API)) return realFetch(input, init);
    const res = await fake.send({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url,
      headers: headersOf(init?.headers),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    for (const [frag, n] of dropResponses) {
      if (n > 0 && url.includes(frag)) {
        dropResponses.set(frag, n - 1);
        throw new TypeError('fetch failed'); // 机构已执行，响应在路上丢了
      }
    }
    return new Response(res.body, { status: res.status });
  });
  srv = await buildChainServer(db, {
    PAYMENT_CHANNELS: 'mock,stripe',
    STRIPE_SECRET_KEY: 'sk_test_chain',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    CHECKOUT_BASE_URL: CHECKOUT_BASE,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await srv.close();
  vi.unstubAllGlobals();
});

// ── 小工具 ────────────────────────────────────────────────────────────────

async function createOrder(key = 'k-s'): Promise<string> {
  const r = await call(srv, 'POST', '/api/v1/orders', {
    token: await tokenFor('u-1'),
    key,
    body: orderBody(),
  });
  expect(r.status).toBe(201);
  return String(r.json['order_id']);
}

async function payStripe(orderId: string, key: string) {
  return call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
    token: await tokenFor('u-1'),
    key,
    body: { channel: 'stripe' },
  });
}

function tokenOf(payUrl: unknown): string {
  return new URL(String(payUrl)).searchParams.get('t') ?? '';
}

async function landing(orderId: string, t: string): Promise<string | null> {
  const res = await realFetch(`${srv.url}${PAY_LINK_PREFIX}/${orderId}?t=${t}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('location');
}

/** 独立实现的 Stripe-Signature（不复用被测的 verify——共享了就成自证）。 */
async function postStripeEvent(event: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  return realFetch(`${srv.url}${PAY_CALLBACK_PREFIX}/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [STRIPE_SIGNATURE_HEADER]: `t=${t},v1=${v1}` },
    body: raw,
  });
}

async function paymentRow(orderId: string) {
  const rows = await db`
    select provider_ref, charge_currency, charge_amount, status
      from payments where order_id = ${orderId} order by created_at desc limit 1`;
  const p = rows[0];
  if (p === undefined) throw new Error('无支付行');
  return {
    providerRef: String(p['provider_ref']),
    currency: String(p['charge_currency']),
    amount: Number(p['charge_amount']),
    status: String(p['status']),
  };
}

/** 按 Stripe 真实形态发 `checkout.session.completed`（会话号/金额/币种取自库里登记的那一笔）。 */
async function completeCheckout(orderId: string, eventId: string): Promise<Response> {
  const p = await paymentRow(orderId);
  return postStripeEvent({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        object: 'checkout.session',
        id: p.providerRef,
        payment_status: 'paid',
        status: 'complete',
        amount_total: p.amount,
        currency: p.currency.toLowerCase(),
        // ⚠️ 必须带本系统标记：`create()` 写进 Session 的就是 `order_id` + `source` **两键**
        //    （B5 / AJ-198）。只写 order_id 的样本在"归属判定前移到取单号之前"（AJ-310）
        //    之后会被判成"非本系统的钱" → 回调 ignored → 订单永远停在 pending_payment。
        metadata: { order_id: orderId, source: STRIPE_SOURCE_TAG },
        payment_intent: `pi_for_${p.providerRef}`,
        created: Math.floor(Date.now() / 1000),
      },
    },
  });
}

async function orderStatus(orderId: string): Promise<string> {
  const rows = await db`select status from orders where id = ${orderId}`;
  return String(rows[0]?.['status']);
}

const stripeCalls = (path: string) =>
  fake.calls.filter((c) => new URL(c.url).pathname === path && c.method === 'POST');

// ── 用例 ──────────────────────────────────────────────────────────────────

describe('Stripe 整链：建单 → 托管页 → 回调落账 → 退款', () => {
  it('会话参数正确、短链 302 到托管页、签名回调置 paid、退款先反查 PI 再退、订单 refunded', async () => {
    const orderId = await createOrder();
    const pay = await payStripe(orderId, 'pay-s1');
    expect(pay.status).toBe(200);
    expect(pay.json['channel']).toBe('stripe');

    // ① 建会话：确定性幂等键 + expires_at = 订单到期 + 30min + 2min（KD-9：与调用时刻无关）
    const creates = stripeCalls('/v1/checkout/sessions');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.headers?.['idempotency-key']).toBe(`pay-${orderId}-stripe`);
    const form = new URLSearchParams(textBodyLike(creates[0]?.body));
    const [o] = await db`select expires_at, total_jpy from orders where id = ${orderId}`;
    const orderExpSec = Math.ceil((o?.['expires_at'] as Date).getTime() / 1000);
    expect(Number(form.get('expires_at'))).toBe(
      orderExpSec + STRIPE_MIN_SESSION_TTL_SEC + STRIPE_SESSION_MARGIN_SEC,
    );
    expect(form.get('payment_intent_data[metadata][order_id]')).toBe(orderId);
    // D-60①：订单地址快照随会话附给 PaymentIntent（Radar 风控 / 拒付举证）；一致性审计 C14（AJ-176）
    expect(form.get('payment_intent_data[shipping][name]')).toBe('Jane Doe');
    expect(form.get('payment_intent_data[shipping][address][line1]')).toBe('1 Infinite Loop');
    expect(form.get('payment_intent_data[shipping][address][city]')).toBe('Cupertino');
    expect(form.get('payment_intent_data[shipping][address][state]')).toBe('CA');
    expect(form.get('payment_intent_data[shipping][address][postal_code]')).toBe('95014');
    expect(form.get('payment_intent_data[shipping][address][country]')).toBe('US');
    expect(form.get('payment_intent_data[shipping][phone]')).toBe('+14155550123');

    // ② 登记的钱：通道对外宣告 USD（channels.ts），按订单自己的汇率快照折算，整数分
    const p = await paymentRow(orderId);
    expect(p.providerRef).toMatch(/^cs_test_/);
    expect(p.currency).toBe('USD');
    // 独立算期望：20,150 円 × 0.0067（fixture 的 USD 展示汇率，建单时入快照）= 135.005 USD
    //   = 13,500.5 分 → half-up → 13,501 分（money.ts toMinor 口径）。不调被测函数算期望
    expect(p.amount).toBe(13_501);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('13501');
    expect(form.get('line_items[0][price_data][currency]')?.toLowerCase()).toBe('usd');

    // ③ 短链：明文 token 只在响应里；落地 302 到 Stripe 托管页
    const payload = pay.json['payload'] as { pay_url?: string };
    expect(payload.pay_url?.startsWith(`${CHECKOUT_BASE}/o/${orderId}?t=`)).toBe(true);
    expect(await landing(orderId, tokenOf(payload.pay_url))).toBe(
      `https://checkout.stripe.com/c/pay/${p.providerRef}`,
    );

    // ④ 签名回调 → paid（同一事件重投 → 200 且不重复落账）
    expect((await completeCheckout(orderId, 'evt_chain_paid')).status).toBe(200);
    expect(await orderStatus(orderId)).toBe('paid');
    expect((await paymentRow(orderId)).status).toBe('succeeded');
    expect((await completeCheckout(orderId, 'evt_chain_paid')).status).toBe(200);
    const paidEvents =
      await db`select count(*)::int n from order_events where order_id = ${orderId} and status = 'paid'`;
    expect(paidEvents[0]?.['n']).toBe(1);

    // ⑤ 退款：GET 会话 → 用 PI 退（KD-11）；原币原额；幂等键 refund:<orderId>
    const admin = await tokenFor('u-admin', 'admin');
    const r = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: admin,
      key: 'rf-1',
      body: { reason: '缺货' },
    });
    expect(r.status).toBe(202);
    expect(await orderStatus(orderId)).toBe('refunded');
    const gets = fake.calls.filter(
      (c) => c.method === 'GET' && c.url.includes('/v1/checkout/sessions/'),
    );
    expect(gets).toHaveLength(1);
    const refunds = stripeCalls('/v1/refunds');
    expect(refunds).toHaveLength(1);
    const rf = new URLSearchParams(textBodyLike(refunds[0]?.body));
    expect(rf.get('payment_intent')).toBe(`pi_for_${p.providerRef}`);
    expect(rf.get('amount')).toBe(String(p.amount));
    expect(refunds[0]?.headers?.['idempotency-key']).toBe(`refund:${orderId}`);
    const note =
      await db`select note from order_events where order_id = ${orderId} and status = 'refunded'`;
    expect(String(note[0]?.['note'])).toMatch(/^re_test_/);
  });
});

describe('KD-3：支付短链明文 token 不落幂等表；重放补发新链接', () => {
  it('幂等表只存占位 token；同键重放 → 不再调 Stripe、返回可用的新链接、旧链接失效；已付后重放的链接落地即失效页', async () => {
    const orderId = await createOrder();
    const first = await payStripe(orderId, 'pay-kd3');
    const t1 = tokenOf((first.json['payload'] as { pay_url?: string }).pay_url);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);

    const stored =
      await db`select response::text as r from idempotency_keys where key like ${'%pay-kd3%'}`;
    expect(stored).toHaveLength(1);
    expect(String(stored[0]?.['r'])).not.toContain(t1);
    expect(String(stored[0]?.['r'])).toContain('t=redacted');

    const replay = await payStripe(orderId, 'pay-kd3');
    expect(replay.status).toBe(200);
    const t2 = tokenOf((replay.json['payload'] as { pay_url?: string }).pay_url);
    expect(t2).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).not.toBe(t1);
    expect(stripeCalls('/v1/checkout/sessions')).toHaveLength(1); // 重放不是第二次业务操作
    const p = await paymentRow(orderId);
    expect(await landing(orderId, t2)).toBe(`https://checkout.stripe.com/c/pay/${p.providerRef}`);
    expect(await landing(orderId, t1)).toBe(`${CHECKOUT_BASE}/pay/expired`); // 复用即轮换
    expect(JSON.stringify(srv.sink.lines)).not.toContain(t2); // 补发的 token 同样不进日志
    expect(srv.sink.find('pay_link_reissued_on_replay')).toHaveLength(1);

    // 付款后再重放：不补发（订单已不可付），占位 token 的链接落地即失效页
    expect((await completeCheckout(orderId, 'evt_kd3')).status).toBe(200);
    const late = await payStripe(orderId, 'pay-kd3');
    expect(late.status).toBe(200);
    const t3 = tokenOf((late.json['payload'] as { pay_url?: string }).pay_url);
    expect(t3).toBe('redacted');
    expect(await landing(orderId, t3)).toBe(`${CHECKOUT_BASE}/pay/expired`);
  });
});

describe('KD-9：建会话"机构已执行、响应丢失"后稍晚重试', () => {
  it('5 分钟后用户重试：同键同参 → Stripe 回原会话（不是 idempotency_error），只存在一个会话', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const orderId = await createOrder();
    dropResponses.set('/v1/checkout/sessions', 3); // 客户端 3 次尝试全部"执行了但没收到答复"
    const failed = await payStripe(orderId, 'pay-kd9');
    expect(failed.status).toBe(500);
    expect(await db`select 1 from payments where order_id = ${orderId}`).toHaveLength(0);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    const retry = await payStripe(orderId, 'pay-kd9');
    expect(retry.status).toBe(200);
    const bodies = stripeCalls('/v1/checkout/sessions').map((c) => c.body);
    expect(bodies.length).toBe(4);
    expect(new Set(bodies).size).toBe(1); // 四次请求逐字节相同
    const p = await paymentRow(orderId);
    expect(p.providerRef).toBe('cs_test_0001'); // 就是第一次在机构侧建出来的那个
  });
});

describe('KD-4：退款"机构已执行、响应丢失"后重试', () => {
  it('停在 refunding → 客服换了一句原因再点 → 沿用首次原因、同键同参 → 回同一笔退款 → refunded', async () => {
    const orderId = await createOrder();
    await payStripe(orderId, 'pay-kd4');
    expect((await completeCheckout(orderId, 'evt_kd4')).status).toBe(200);
    const admin = await tokenFor('u-admin', 'admin');

    dropResponses.set('/v1/refunds', 3);
    const first = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: admin,
      key: 'rf-kd4-a',
      body: { reason: '缺货' },
    });
    expect(first.status).toBe(500);
    expect(await orderStatus(orderId)).toBe('refunding');
    // 失败留痕进管理端时间线（技术文档 refunding 行原意；一致性审计 C13，AJ-176），买家时间线看不到它
    const failedEv = await db`
      select note, actor from order_events where order_id = ${orderId} and status = 'refund_failed'`;
    expect(failedEv).toHaveLength(1);
    expect(failedEv[0]?.['actor']).toBe('admin:u-admin');
    const buyerDetail = await call(srv, 'GET', `/api/v1/orders/${orderId}`, {
      token: await tokenFor('u-1'),
    });
    expect(JSON.stringify(buyerDetail.json['timeline'])).not.toContain('refund_failed');

    const retry = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: admin,
      key: 'rf-kd4-b',
      body: { reason: '客户催了，再退一次' },
    });
    expect(retry.status).toBe(202);
    expect(await orderStatus(orderId)).toBe('refunded');
    const bodies = stripeCalls('/v1/refunds').map((c) => c.body);
    expect(bodies.length).toBe(4);
    expect(new Set(bodies).size).toBe(1);
    expect(new URLSearchParams(textBodyLike(bodies[0])).get('metadata[reason]')).toBe('缺货');
    const note =
      await db`select note from order_events where order_id = ${orderId} and status = 'refunded'`;
    expect(note[0]?.['note']).toBe('re_test_0001'); // 机构侧只有一笔
    expect(srv.sink.find('admin_order_refund_retry')).toHaveLength(1);
  });
});

describe('§14.2 支付前提示：小程序算出的"实扣币种与金额" = 服务端真正扣的（AJ-180）', () => {
  /**
   * @why 小程序的 chargeOptions 复述了服务端 resolveCharge 的规则（契约 ChannelView 不带扣款币种）；
   *      这条用**真路由**的输出喂小程序自己的纯函数，再与发起支付的实扣对账——两边任何一边漂了都红。
   *      顺带钉住原缺陷：只按 JPY 查通道时 stripe（只对外声明 USD）根本不出现。
   */
  it('按 CHARGE_CURRENCY_ORDER 逐币种查通道 → stripe 只在 USD 下出现；提示的金额 = 发起支付的 charge', async () => {
    const orderId = await createOrder('k-142');
    const token = await tokenFor('u-1');
    const order = await call(srv, 'GET', `/api/v1/orders/${orderId}`, { token });
    const totalJpy = Number(order.json['total_jpy']);
    const listings = [];
    for (const currency of CHARGE_CURRENCY_ORDER) {
      const r = await call(
        srv,
        'GET',
        `/api/v1/pay/channels?country=US&currency=${currency}&amount_jpy=${String(totalJpy)}`,
      );
      expect(r.status).toBe(200);
      listings.push({ currency, resp: r.json });
    }
    const jpyOnly = chargeOptions([listings[0]], order.json).map((o) => o.channel);
    expect(jpyOnly, '只按 JPY 查时银行卡不出现——这正是原缺陷').not.toContain('stripe');

    const opts = chargeOptions(listings, order.json);
    const card = opts.find((o) => o.channel === 'stripe');
    expect(card?.charge.currency).toBe('USD');

    const pay = await payStripe(orderId, 'pay-142');
    expect(pay.status).toBe(200);
    expect(pay.json['charge']).toEqual({
      currency: card?.charge.currency,
      amount: card?.charge.amount,
    });
    expect(payNotice(opts, order.json).join('\n')).toContain(
      '在手机浏览器中打开完成支付' /* AJ-244：原为「离开微信」 */,
    );
  });
});

describe('F-03：退款 pending 的出口（AJ-178）', () => {
  /**
   * @why 原先 pending 分支只打一条 info 日志就回 202：退款单号没落库，重试沿用同一幂等键，
   *      Stripe 回放的是**首次响应快照**（仍是 pending）——订单永远停在 refunding、没有任何告警
   *      （独立审查辨析 §3.1）。这组用例钉住三条出口：查询、确认失败后换键、以及查询失败不误判。
   */
  async function paidOrder(tag: string): Promise<string> {
    const orderId = await createOrder(`k-${tag}`);
    await payStripe(orderId, `pay-${tag}`);
    expect((await completeCheckout(orderId, `evt_${tag}`)).status).toBe(200);
    return orderId;
  }
  const refund = async (orderId: string, key: string, reason = '缺货') =>
    call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: await tokenFor('u-admin', 'admin'),
      key,
      body: { reason },
    });
  const refundKeys = () =>
    stripeCalls('/v1/refunds').map((c) => c.headers?.['idempotency-key'] ?? '');
  const refundGets = (ref: string) =>
    fake.calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/v1/refunds/${ref}`));
  const events = (orderId: string, status: string) =>
    db`select note, actor from order_events where order_id = ${orderId} and status = ${status} order by id`;

  it('pending → 单号落库 → 再点只查询不再 POST → 机构完成后再点 → refunded（同一单号）', async () => {
    const orderId = await paidOrder('f3a');
    fake.nextRefundStatus('pending');
    const first = await refund(orderId, 'rf-f3a-1');
    expect(first.status).toBe(202);
    expect(first.json['outcome']).toBe('pending');
    expect(await orderStatus(orderId)).toBe('refunding');
    const pend = await events(orderId, 'refund_pending');
    expect(pend.map((r) => r['note'])).toEqual(['re_test_0001']);
    expect(pend[0]?.['actor']).toBe('admin:u-admin');

    const still = await refund(orderId, 'rf-f3a-2');
    expect(still.status).toBe(202);
    expect(still.json['outcome']).toBe('pending');
    expect(refundKeys()).toHaveLength(1); // 没有第二次 POST（那只会拿回首次快照）
    expect(refundGets('re_test_0001')).toHaveLength(1);
    expect(srv.sink.find('admin_order_refund_still_pending')).toHaveLength(1);

    fake.settleRefund('re_test_0001', 'succeeded');
    const done = await refund(orderId, 'rf-f3a-3');
    expect(done.status).toBe(202);
    expect(done.json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
    expect((await events(orderId, 'refunded')).map((r) => r['note'])).toEqual(['re_test_0001']);
    expect((await paymentRow(orderId)).status).toBe('refunded');
    expect(refundKeys()).toHaveLength(1);
  });

  // 审计 PAY-03（2026-10-14）：生产装配下 refund.updated 回调直接推进 pending 的整单退款——不用等管理员再点一次
  it('🔴 pending 退款 → 机构发 refund.updated(succeeded) 签名回调 → 订单 refunded，webhook_events 记 refund_progress', async () => {
    const orderId = await paidOrder('f3w');
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-f3w-1')).json['outcome']).toBe('pending');
    const pend = await events(orderId, 'refund_pending');
    const ref = String(pend[0]?.['note']);
    const res = await postStripeEvent({
      id: 'evt_chain_refund_ok',
      type: 'refund.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          object: 'refund',
          id: ref,
          amount: 1,
          currency: 'usd',
          status: 'succeeded',
          payment_intent: 'pi_test',
          metadata: { order_id: orderId, source: STRIPE_SOURCE_TAG },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await orderStatus(orderId)).toBe('refunded');
    expect((await paymentRow(orderId)).status).toBe('refunded');
    const logged =
      await db`select result from webhook_events where event_id = 'evt_chain_refund_ok'`;
    expect(logged[0]?.['result']).toBe('refund_progress');
  });

  /**
   * 退款回补库存（剩余清单 1-1 / C32）：未发货的单退款后，库存要还回去。
   * @why 原来只有关单、取消、拉黑会回补；退完库存却停在扣减后的值——运营要记得手动改库存，否则这件商品"少了"几件。
   * @why 例外是「缺货」（AJ-427，统一结论 5.2）：货本来就没有，加回去等于重新开卖一件买不到的东西。
   * @why 已发货的单**不**回补：货已经寄出去了，退款不代表货回来了。
   */
  const stockOf = async (): Promise<number> => {
    const id = CHAIN_ITEMS[0].product_id;
    const [r] = await db`select stock from products where id = ${id}`;
    return Number(r?.['stock']);
  };

  it('🔴 未发货的单退款成功 → 库存回补', async () => {
    const before = await stockOf();
    const orderId = await paidOrder('rs1');
    expect(await stockOf()).toBeLessThan(before);
    const r = await refund(orderId, 'rf-rs1', '买家取消：改主意了');
    expect(r.json['outcome']).toBe('succeeded');
    expect(await stockOf()).toBe(before);
    // 剩余清单 2-1：退款落定发 order.refunded（进业务日志，邮件订阅者据此发信）
    const logged = srv.sink
      .find('business_event')
      .filter((l) => l['order_id'] === orderId)
      .map((l) => (l['ctx'] as { domain_event?: string }).domain_event);
    expect(logged).toContain('order.refunded');
  });

  /**
   * @why 回补不幂等：同一笔退款被落定两次（两个管理员几乎同时点、都查到 succeeded）时，
   *      只有 markRefunded 返回 true 的那一次能回补；第二次必须原样返回，不再加库存。
   */
  it('🔴 同一笔退款第二次落定（已 refunded）→ 不再回补库存', async () => {
    const before = await stockOf();
    const orderId = await paidOrder('rs3');
    expect((await refund(orderId, 'rf-rs3', '买家取消')).json['outcome']).toBe('succeeded');
    expect(await stockOf()).toBe(before);
    const [pay] = await db`select id from payments where order_id = ${orderId}`;
    const provider: PaymentProvider = {
      ...({} as PaymentProvider),
      refund: () =>
        Promise.resolve({ providerRef: 'cs', refundRef: 're_again', outcome: 'succeeded' }),
      refundStatus: () => Promise.resolve('succeeded'),
    };
    const bus = createEventBus(srv.logger);
    const refunded: string[] = [];
    bus.subscribe('order.refunded', (e) => refunded.push(String(e.orderId)));
    await executeRefund(
      { db, logger: srv.logger, clock: { now: () => new Date() }, events: bus },
      provider,
      {
        orderId,
        paymentId: String(pay?.['id']),
        channel: 'stripe',
        request: {
          orderId,
          providerRef: 'cs',
          amountJpy: 1,
          currency: 'USD',
          amountMinor: 1,
          reason: 'x',
        },
        progress: { pendingRef: null, confirmedFailures: 0 },
        actor: 'admin:u-admin',
        hasDispute: false,
      },
    );
    expect(refunded).toEqual([]); // 第二次落定不再发 order.refunded（不会重复通知买家）
    expect(await stockOf()).toBe(before);
    expect(await orderStatus(orderId)).toBe('refunded');
  });

  it('🔴 管理端发货 → 发 order.shipped（带承运商，2-1）', async () => {
    const orderId = await paidOrder('sh1');
    const r = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/ship`, {
      token: await tokenFor('u-admin', 'admin'),
      key: 'ship-sh1',
      body: { carrier: 'EMS', tracking_no: 'EM123456789JP' },
    });
    expect(r.status).toBe(200);
    const ev = srv.sink
      .find('business_event')
      .filter((l) => l['order_id'] === orderId)
      .map((l) => l['ctx'] as { domain_event?: string; carrier?: string });
    expect(ev.find((e) => e.domain_event === 'order.shipped')?.carrier).toBe('EMS');
    // 剩余清单 3-5：买家与管理端的订单详情都带官方查件链接（日本邮便 S10 单号）
    const jp =
      'https://trackings.post.japanpost.jp/services/srv/search?requestNo1=EM123456789JP&search.x=1&search.y=1&locale=en&startingUrlPatten=';
    const buyer = await call(srv, 'GET', `/api/v1/orders/${orderId}`, {
      token: await tokenFor('u-1'),
    });
    expect(buyer.json['tracking_url']).toBe(jp);
    const admin = await call(srv, 'GET', `/api/v1/admin/orders/${orderId}`, {
      token: await tokenFor('u-admin', 'admin'),
    });
    expect(admin.json['tracking_url']).toBe(jp);
  });

  it('🔴 AJ-427「缺货」退款（未发货）→ 库存不回补；单照常 refunded、照常发 order.refunded', async () => {
    const orderId = await paidOrder('rs4');
    const after = await stockOf();
    const r = await refund(orderId, 'rf-rs4', '缺货：供应商断货');
    expect(r.json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(await stockOf()).toBe(after);
    expect(
      srv.sink.find('order_restock_skipped').filter((l) => l['order_id'] === orderId)[0]?.['ctx'],
    ).toEqual({ reason: 'out_of_stock_refund' });
    const logged = srv.sink
      .find('business_event')
      .filter((l) => l['order_id'] === orderId)
      .map((l) => (l['ctx'] as { domain_event?: string }).domain_event);
    expect(logged).toContain('order.refunded');
  });

  it('🔴 AJ-427「缺货」退款先 pending、下一次查询才落定 → 仍不回补（落定时认的是首次登记的理由）', async () => {
    const orderId = await paidOrder('rs5');
    const after = await stockOf();
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-rs5-1', '缺货')).json['outcome']).toBe('pending');
    const ref = String((await events(orderId, 'refund_pending'))[0]?.['note']);
    fake.settleRefund(ref, 'succeeded');
    // 第二次点击时运营换了一个理由：落定只认首次登记的（机构请求同样沿用首次，见路由 KD-4）
    expect((await refund(orderId, 'rf-rs5-2', '买家取消')).json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(await stockOf()).toBe(after);
  });

  it('已发货的单退款成功 → 库存不回补（货已经寄出）', async () => {
    const before = await stockOf();
    const orderId = await paidOrder('rs2');
    const after = await stockOf();
    await db`update orders set status = 'shipped', shipped_at = now(), carrier = 'EMS', tracking_no = 'EM123' where id = ${orderId}`;
    expect((await refund(orderId, 'rf-rs2')).json['outcome']).toBe('succeeded');
    expect(await stockOf()).toBe(after);
    expect(after).toBeLessThan(before);
  });

  it('pending → 机构判失败 → 再点：记"确认失败" + 换新键重新发起 → refunded', async () => {
    const orderId = await paidOrder('f3b');
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-f3b-1')).json['outcome']).toBe('pending');
    fake.settleRefund('re_test_0001', 'failed');

    const retry = await refund(orderId, 'rf-f3b-2');
    expect(retry.status).toBe(202);
    expect(retry.json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(refundKeys()).toEqual([`refund:${orderId}`, `refund:${orderId}:1`]);
    expect((await events(orderId, 'refund_failed')).map((r) => r['note'])).toEqual([
      'provider_failed:re_test_0001',
    ]);
    expect((await events(orderId, 'refunded')).map((r) => r['note'])).toEqual(['re_test_0002']);
  });

  /**
   * SEC2-02：**机构调用失败、回 500 的那一次退款**，`admin_audit` 里必须有这一行。
   *
   * @why 这是全表最需要留痕的一类请求——"钱可能已经退了、我们不知道"。
   *      而审计中间件默认只写 2xx ⇒ 它一行都没有；管理员若不再重试就永远补不上
   *      （`admin_audit` 是 append-only，触发器拒 UPDATE/DELETE）。
   *      修法是退款路由在第一段事务提交后调用 `markAuditCommitted`，并把最终状态码落库。
   * @why 断言 `status_code = 500` 而不只是"有一行"：只写行而不记状态的话，
   *      事后回溯会把"发起了但没成"读成"做成了"——那比没有审计更坏。
   */
  it('🔴 机构调用失败回 500 的那次退款：admin_audit 有这一行，且 status_code = 500（SEC2-02）', async () => {
    const orderId = await paidOrder('f3i');
    fake.nextRefundStatus('failed');
    const r = await refund(orderId, 'rf-f3i-1');
    expect(r.status).toBe(500);
    // 订单真的停在 refunding（第一段事务已提交 ⇒ "改动已发生"这句成立）
    expect(await orderStatus(orderId)).toBe('refunding');

    // 审计写在响应之后（prefinish/end 回调里），且登记为在途作业 ⇒ 要等它落库
    await waitUntil(
      async () => (await db`select 1 from admin_audit where target = ${orderId}`).length > 0,
      'admin_audit 里出现这次退款的审计行',
    );
    const rows = await db`
      select action, target, status_code, after from admin_audit where target = ${orderId}`;
    expect(rows).toHaveLength(1);
    // AJ-341：target **必须**是订单号。错误路径上 router 会把 req.params 还原成空，
    // 那时现取就落库成 NULL——"谁在什么时候点过退款"查得到，"退的是哪一单"查不到。
    expect(String(rows[0]?.['target'])).toBe(orderId);
    expect(String(rows[0]?.['action'])).toContain('refund');
    expect(Number(rows[0]?.['status_code'])).toBe(500);
    // after 是脱敏后的请求体（退款理由），不是 null
    expect((rows[0]?.['after'] as { reason?: string } | null)?.['reason']).toBe('缺货');
  });

  it('POST 直接回 failed → 50000 + 确认失败留痕 → 再点换新键（不是拿回缓存的失败）→ refunded', async () => {
    const orderId = await paidOrder('f3c');
    fake.nextRefundStatus('failed');
    const first = await refund(orderId, 'rf-f3c-1');
    expect(first.status).toBe(500);
    expect(await orderStatus(orderId)).toBe('refunding');
    expect((await events(orderId, 'refund_failed')).map((r) => r['note'])).toEqual([
      'provider_failed:re_test_0001',
    ]);

    const retry = await refund(orderId, 'rf-f3c-2');
    expect(retry.status).toBe(202);
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(refundKeys()).toEqual([`refund:${orderId}`, `refund:${orderId}:1`]);
  });

  /**
   * 第三轮审查 OPS3-03：退款在途（refunding）期间落了拒付。
   * @why 原 refundGuard 对 has_dispute 一律 40907——而 refunding 下的再次点击只是"查询在途那笔"或
   *      "同一幂等键重放"，都不会让钱再动一次；挡住它们的结果是订单永远停在 refunding。
   *      只有"换新键重新发起一笔"才会动钱，拒付下只拦这一步。
   */
  const disputeNow = (orderId: string) =>
    db`update orders set has_dispute = true where id = ${orderId}`;

  it('🔴 在途退款 + 期间落拒付 → 再点仍可**查询**：机构已完成 → refunded（不被 40907 挡死）', async () => {
    const orderId = await paidOrder('f3e');
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-f3e-1')).json['outcome']).toBe('pending');
    await disputeNow(orderId);
    fake.settleRefund('re_test_0001', 'succeeded');
    const r = await refund(orderId, 'rf-f3e-2');
    expect(r.status).toBe(202);
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(refundKeys()).toHaveLength(1);
  });

  it('🔴 在途退款 + 期间落拒付 → 查询结果是失败：记确认失败，但**不换键重发**（40907）', async () => {
    const orderId = await paidOrder('f3f');
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-f3f-1')).json['outcome']).toBe('pending');
    await disputeNow(orderId);
    fake.settleRefund('re_test_0001', 'failed');
    const r = await refund(orderId, 'rf-f3f-2');
    expect(r.json['code']).toBe(40907);
    expect(refundKeys()).toHaveLength(1); // 没有第二把键
    expect((await events(orderId, 'refund_failed')).map((x) => x['note'])).toEqual([
      'provider_failed:re_test_0001',
    ]);
    expect(await orderStatus(orderId)).toBe('refunding');
  });

  it('🔴 上次结果未知（网络）+ 期间落拒付 → 同一把键重放照常进行（不会动第二笔钱）', async () => {
    const orderId = await paidOrder('f3g');
    dropResponses.set('/v1/refunds', 10);
    expect((await refund(orderId, 'rf-f3g-1')).status).toBe(500);
    dropResponses.delete('/v1/refunds');
    await disputeNow(orderId);
    const r = await refund(orderId, 'rf-f3g-2');
    expect(r.status).toBe(202);
    expect(new Set(refundKeys())).toEqual(new Set([`refund:${orderId}`]));
  });

  it('🔴 上次机构确认失败（无在途单）+ 期间落拒付 → 40907，不发起新键', async () => {
    const orderId = await paidOrder('f3h');
    fake.nextRefundStatus('failed');
    expect((await refund(orderId, 'rf-f3h-1')).status).toBe(500);
    await disputeNow(orderId);
    const r = await refund(orderId, 'rf-f3h-2');
    expect(r.json['code']).toBe(40907);
    expect(refundKeys()).toEqual([`refund:${orderId}`]);
  });

  it('查询本身失败（网络）→ 50000、不 POST、不记"退款失败"（查不到 ≠ 退款失败）', async () => {
    const orderId = await paidOrder('f3d');
    fake.nextRefundStatus('pending');
    expect((await refund(orderId, 'rf-f3d-1')).json['outcome']).toBe('pending');
    dropResponses.set('/v1/refunds/re_test_0001', 10);

    const r = await refund(orderId, 'rf-f3d-2');
    expect(r.status).toBe(500);
    expect(await orderStatus(orderId)).toBe('refunding');
    expect(refundKeys()).toHaveLength(1);
    expect(await events(orderId, 'refund_failed')).toHaveLength(0);
    expect(srv.sink.find('admin_order_refund_status_query_failed')).toHaveLength(1);
  });
});

/**
 * 迟到付款的退款出口（剩余清单 1-5 / B2，AJ-368）。
 * @why 订单已关（expired / cancelled）后钱才到：落账被拒（late_payment）是对的，但此前**没有出口**——
 *      退款闸门只认 paid / shipped / delivered，运营只能去 Stripe 后台手退，系统里没有任何留痕。
 * @why 闸门放行的凭据是回调落下的 `late_paid` 事件，而不是"订单已关"本身：
 *      没收到钱的已关单若也能点退款，订单会迁进 refunding、机构侧必败（会话没有 PI），从此卡单。
 * @why 不回补库存：关单那一刻库存已经还回去了，再还一次就是凭空多出货。
 */
describe('迟到付款：已关单收到钱 → 管理端可退款（1-5）', () => {
  const stockOf = async (): Promise<number> => {
    const [r] = await db`select stock from products where id = ${CHAIN_ITEMS[0].product_id}`;
    return Number(r?.['stock']);
  };
  /** 建单 → 建会话 → 模拟关单作业（迁 expired + 回补库存）。 */
  async function closedOrder(tag: string): Promise<{ orderId: string; stockAfterClose: number }> {
    const before = await stockOf();
    const orderId = await createOrder(`k-${tag}`);
    await payStripe(orderId, `pay-${tag}`);
    await db`update orders set status = 'expired', updated_at = now() where id = ${orderId}`;
    await db`update products set stock = ${before} where id = ${CHAIN_ITEMS[0].product_id}`;
    return { orderId, stockAfterClose: before };
  }
  const refund = async (orderId: string, key: string) =>
    call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: await tokenFor('u-admin', 'admin'),
      key,
      body: { reason: '迟到付款，订单已关闭' },
    });

  it('🔴 已关单收到钱 → 记 late_paid（带机构单号）→ 退款 202 → refunded、支付行 refunded、库存不重复回补', async () => {
    const { orderId, stockAfterClose } = await closedOrder('lp1');
    const p = await paymentRow(orderId);
    expect((await completeCheckout(orderId, 'evt_lp1')).status).toBe(200);
    expect(await orderStatus(orderId)).toBe('expired');
    const marks =
      await db`select note, actor from order_events where order_id = ${orderId} and status = 'late_paid'`;
    expect(marks.map((r) => r['note'])).toEqual([p.providerRef]);
    expect(marks[0]?.['actor']).toBe('provider:stripe');
    const detail = await call(srv, 'GET', `/api/v1/admin/orders/${orderId}`, {
      token: await tokenFor('u-admin', 'admin'),
    });
    expect(detail.json['late_paid']).toBe(true); // 管理端据此在已关单上亮出退款按钮

    const r = await refund(orderId, 'rf-lp1');
    expect(r.status).toBe(202);
    expect(r.json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
    expect((await paymentRow(orderId)).status).toBe('refunded');
    const rf = new URLSearchParams(textBodyLike(stripeCalls('/v1/refunds')[0]?.body));
    expect(rf.get('payment_intent')).toBe(`pi_for_${p.providerRef}`);
    expect(rf.get('amount')).toBe(String(p.amount));
    expect(await stockOf()).toBe(stockAfterClose);
  });

  it('已关单但没有收到钱（无 late_paid）→ 40902，不迁状态、不调机构', async () => {
    const { orderId } = await closedOrder('lp2');
    const r = await refund(orderId, 'rf-lp2');
    expect(r.status).toBe(409);
    expect(r.json['code']).toBe(40902);
    expect(await orderStatus(orderId)).toBe('expired');
    const detail = await call(srv, 'GET', `/api/v1/admin/orders/${orderId}`, {
      token: await tokenFor('u-admin', 'admin'),
    });
    expect(detail.json['late_paid']).toBe(false);
    expect(stripeCalls('/v1/refunds')).toHaveLength(0);
  });

  /**
   * 扫描 M-01：第一次退款没当场落定（机构回 pending / 超时 / 熔断）→ 订单进 refunding；
   * 原实现再点时按"succeeded 支付行"找钱，迟到付款的支付行永远不是 succeeded → 40902，订单从此卡死。
   */
  it('🔴 迟到付款单第一次退款 pending → 订单 refunding → 机构完成后再点 → 查询并落定 refunded', async () => {
    const { orderId } = await closedOrder('lp4');
    await completeCheckout(orderId, 'evt_lp4');
    fake.nextRefundStatus('pending');
    const first = await refund(orderId, 'rf-lp4-1');
    expect(first.json['outcome']).toBe('pending');
    expect(await orderStatus(orderId)).toBe('refunding');
    fake.settleRefund('re_test_0001', 'succeeded');
    const again = await refund(orderId, 'rf-lp4-2');
    expect(again.status).toBe(202);
    expect(again.json['outcome']).toBe('succeeded');
    expect(await orderStatus(orderId)).toBe('refunded');
  });

  /**
   * 扫描 M-02：迟到付款的支付行不是 succeeded / refunded，拒付原先按 no_succeeded_payment 被拒——
   * 订单上看不到拒付、举证期限无人追踪，退款按钮照样亮着（机构会以 charge_disputed 拒退）。
   */
  it('🔴 迟到付款单收到拒付 → has_dispute 落到订单上 → 退款被 40907 拦住', async () => {
    const { orderId } = await closedOrder('lp5');
    const p = await paymentRow(orderId);
    await completeCheckout(orderId, 'evt_lp5');
    const opened = await postStripeEvent({
      id: 'evt_lp5_dp',
      object: 'event',
      type: 'charge.dispute.created',
      data: {
        object: {
          object: 'dispute',
          id: 'dp_lp5',
          payment_intent: `pi_for_${p.providerRef}`,
          amount: p.amount,
          currency: p.currency.toLowerCase(),
          created: Math.floor(Date.now() / 1000) - 60,
          status: 'needs_response',
        },
      },
    });
    expect(opened.status).toBe(200);
    const [o] = await db`select has_dispute from orders where id = ${orderId}`;
    expect(o?.['has_dispute']).toBe(true);
    expect((await refund(orderId, 'rf-lp5')).json['code']).toBe(40907);
  });

  it('同一笔迟到付款的回调重投 → 只记一条 late_paid', async () => {
    const { orderId } = await closedOrder('lp3');
    await completeCheckout(orderId, 'evt_lp3');
    await completeCheckout(orderId, 'evt_lp3b'); // 不同事件 id、同一笔钱（如 async_payment_succeeded 又到）
    const n =
      await db`select count(*)::int n from order_events where order_id = ${orderId} and status = 'late_paid'`;
    expect(n[0]?.['n']).toBe(1);
  });
});

describe('拒付经真 HTTP 回调：开案锁退款/发货，结案（won）解锁', () => {
  it('charge.dispute.created（无 metadata，反查 PI 取单号）→ has_dispute → 退款 40907；closed(won) → 可退', async () => {
    const orderId = await createOrder();
    await payStripe(orderId, 'pay-dp');
    expect((await completeCheckout(orderId, 'evt_dp_paid')).status).toBe(200);
    const p = await paymentRow(orderId);
    const dispute = (status: string) => ({
      object: 'dispute',
      id: 'dp_chain_1',
      payment_intent: `pi_for_${p.providerRef}`,
      amount: p.amount,
      currency: p.currency.toLowerCase(),
      created: Math.floor(Date.now() / 1000) - 60,
      status,
    });
    const opened = await postStripeEvent({
      id: 'evt_dp_open',
      object: 'event',
      type: 'charge.dispute.created',
      data: { object: dispute('needs_response') },
    });
    expect(opened.status).toBe(200);
    expect(
      fake.calls.some((c) => c.url.endsWith(`/v1/payment_intents/pi_for_${p.providerRef}`)),
    ).toBe(true);
    const [o1] = await db`select has_dispute from orders where id = ${orderId}`;
    expect(o1?.['has_dispute']).toBe(true);

    const admin = await tokenFor('u-admin', 'admin');
    const blocked = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: admin,
      key: 'rf-dp-1',
      body: { reason: '缺货' },
    });
    expect(blocked.json['code']).toBe(40907);
    expect(stripeCalls('/v1/refunds')).toHaveLength(0);

    const closed = await postStripeEvent({
      id: 'evt_dp_close',
      object: 'event',
      type: 'charge.dispute.closed',
      data: { object: dispute('won') },
    });
    expect(closed.status).toBe(200);
    await waitUntil(
      async () =>
        (await db`select has_dispute from orders where id = ${orderId}`)[0]?.['has_dispute'] ===
        false,
      '结案后 has_dispute 复位',
    );
    const ok = await call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: admin,
      key: 'rf-dp-2',
      body: { reason: '缺货' },
    });
    expect(ok.status).toBe(202);
    expect(await orderStatus(orderId)).toBe('refunded');
  });
});

describe('换通道后用新通道付款：旧 Stripe 会话被作废（防同一单付两次，AJ-175）', () => {
  it('先选 stripe（建了会话）→ 改选 mock → mock 回调落账 → 旧 cs 会话收到 expire；succeeded 那笔不碰', async () => {
    const orderId = await createOrder();
    expect((await payStripe(orderId, 'pay-sw-1')).status).toBe(200);
    const old = await paymentRow(orderId);
    const sw = await call(srv, 'POST', `/api/v1/orders/${orderId}/pay`, {
      token: await tokenFor('u-1'),
      key: 'pay-sw-2',
      body: { channel: 'mock' },
    });
    expect(sw.status).toBe(200);
    expect(stripeCalls(`/v1/checkout/sessions/${old.providerRef}/expire`)).toHaveLength(0); // 换通道本身不调机构（@limitation 一b）
    expect((await mockCallback(srv, db, orderId, { eventId: 'evt-sw' })).status).toBe(200);
    await waitUntil(
      async () => stripeCalls(`/v1/checkout/sessions/${old.providerRef}/expire`).length === 1,
      '付款成功后旧 Stripe 会话被作废',
    );
    const pays =
      await db`select provider, status from payments where order_id = ${orderId} order by created_at`;
    expect(pays.map((p) => [p['provider'], p['status']])).toEqual([
      ['stripe', 'cancelled'],
      ['mock', 'succeeded'],
    ]);
  });
});

describe('建会话失败的错误码（一致性审计 C4，AJ-176）', () => {
  it('Stripe 建会话 4xx → 50001「支付创建失败 → 重试或切换支付方式」，不是笼统的 50000；不落支付行', async () => {
    const orderId = await createOrder();
    fake.failNext(402, '{"error":{"type":"invalid_request_error","message":"amount too small"}}');
    const r = await payStripe(orderId, 'pay-50001');
    expect(r.status).toBe(500);
    expect(r.json['code']).toBe(50001);
    expect(await db`select 1 from payments where order_id = ${orderId}`).toHaveLength(0);
    expect(await orderStatus(orderId)).toBe('created');
  });
});
