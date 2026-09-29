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
  seedChainFixture,
  tokenFor,
  waitUntil,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { PAY_CALLBACK_PREFIX } from './pay-routes.js';
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
        metadata: { order_id: orderId },
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
    const form = new URLSearchParams(creates[0]?.body ?? '');
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
    const rf = new URLSearchParams(refunds[0]?.body ?? '');
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
    expect(new URLSearchParams(bodies[0]).get('metadata[reason]')).toBe('缺货');
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
    expect(payNotice(opts, order.json).join('\n')).toContain('离开微信');
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
  const refund = async (orderId: string, key: string) =>
    call(srv, 'POST', `/api/v1/admin/orders/${orderId}/refund`, {
      token: await tokenFor('u-admin', 'admin'),
      key,
      body: { reason: '缺货' },
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
