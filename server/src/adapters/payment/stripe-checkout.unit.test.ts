/**
 * 职责：Stripe Checkout 通道的**专属**用例（契约套件之外、只属于这一家的部分）。
 *
 * @why 契约套件保证"所有通道都合格"，但它刻意不碰任何机构特有的东西
 *      （否则套件就变成 Stripe 的形状，第二个通道没法用）。
 *      而恰恰是这些特有部分最容易错：金额最小单位、表单字段名、事件类型映射、
 *      密钥轮换期的多签名——每一条都是"只在真实机构上才存在"的风险。
 *
 * @limitation 三方本身用**假 HTTP 客户端**（`test/helpers/fake-stripe-http.ts`）：
 *              我们自己的建会话 / 编码 / 验签 / 映射全部走真实代码，
 *              只有"Stripe 服务器"那一段是替身（测试策略 T-3）。
 */
import { describe, expect, it } from 'vitest';
import type {
  ChannelConfig,
  HeaderBag,
  PaymentProvider,
  PaymentRequest,
} from '../../ports/payment.js';
import { fixedClock } from '../../../../test/helpers/fixed-clock.js';
import { systemIdGen } from '../ids.js';
import { createFakeStripeHttp } from '../../../../test/helpers/fake-stripe-http.js';
import {
  dispute,
  objectForEvent,
  signStripePayload,
  stripeEvent,
  STRIPE_EVENT_TYPES,
  STRIPE_SIGNATURE_HEADER,
} from '../../../../test/factories/stripe.js';
import {
  createStripeCheckoutProvider,
  STRIPE_SIGNATURE_HEADER as HEADER,
  toMinorUnits,
} from './stripe-checkout.js';

const SECRET = 'whsec_unit_secret';
const NOW = fixedClock('2026-01-02T15:30:00.000Z');
const NOW_SEC = Math.floor(NOW.now().getTime() / 1000);

function config(over: Partial<ChannelConfig['options']> = {}): ChannelConfig {
  return {
    channel: 'stripe',
    enabled: true,
    priority: 20,
    countries: ['*'],
    currencies: ['JPY', 'USD'],
    label: '银行卡',
    options: {
      secretKey: 'sk_test_unit',
      webhookSecret: SECRET,
      successUrl: 'https://example.test/paid',
      cancelUrl: 'https://example.test/cancel',
      apiBase: 'https://api.stripe.test',
      ...over,
    },
  };
}

const REQ: PaymentRequest = {
  orderId: 'sk-1',
  orderNo: '260103-K7Q2MN',
  amountJpy: 12_000,
  currency: 'JPY',
  amountInCurrency: 12_000,
  destCountry: 'US',
  idempotencyKey: 'idem-1',
};

function build(over: Partial<ChannelConfig['options']> = {}) {
  const http = createFakeStripeHttp();
  return {
    http,
    provider: createStripeCheckoutProvider(config(over), { http, clock: NOW, idGen: systemIdGen }),
  };
}

/** 造一条签名正确的事件报文。 */
function signed(type: string, opts: { t?: number; secret?: string; extra?: string } = {}) {
  const object = objectForEvent(type);
  // ⚠️ dispute 对象**不能**硬塞 metadata：真实的 Dispute 上没有它（Stripe 不复制），
  //    塞进去等于把"取不到 order_id → 反查 PaymentIntent"这条路径从测试里抹掉——
  //    P1-7 之所以藏到体检才被发现，这层"贴心的合并"就是掩盖层之一。
  const realistic =
    object['object'] === 'dispute' ? object : { ...object, metadata: { order_id: REQ.orderId } };
  const body = JSON.stringify(stripeEvent(type, realistic));
  const header = signStripePayload(body, opts.secret ?? SECRET, opts.t ?? NOW_SEC);
  const withExtra = opts.extra === undefined ? header : `${header},${opts.extra}`;
  return { raw: Buffer.from(body, 'utf8'), headers: { [HEADER]: withExtra } as HeaderBag };
}

describe('toMinorUnits（最小单位换算：跨境支付最常见的金额事故点）', () => {
  it('JPY 是零小数币种：12000 円 → 12000（**不** ×100）', () => {
    expect(toMinorUnits(12_000, 'JPY')).toBe(12_000);
    expect(toMinorUnits(12_000, 'jpy')).toBe(12_000);
  });

  it('USD 有两位小数：$120.00 → 12000（×100）', () => {
    expect(toMinorUnits(120, 'USD')).toBe(12_000);
    expect(toMinorUnits(12.5, 'USD')).toBe(1250);
  });

  it('四舍五入到整数（机构不接受小数最小单位）', () => {
    expect(toMinorUnits(12.345, 'USD')).toBe(1235);
  });
});

describe('create（建 Checkout Session）', () => {
  it('带上鉴权头与幂等键（缺任一项都会被真实机构拒绝）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const call = http.calls[0];
    expect(call?.headers?.['authorization']).toBe('Bearer sk_test_unit');
    expect(call?.headers?.['idempotency-key']).toBe('idem-1');
    expect(call?.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('表单里带金额、币种与 order 元数据（回调要靠它回带单号）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const form = new URLSearchParams(http.calls[0]?.body ?? '');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][currency]')).toBe('jpy');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('12000');
    expect(form.get('metadata[order_id]')).toBe('sk-1');
    expect(form.get('client_reference_id')).toBe('sk-1');
    // ⚠️ 体检 P1-7：payment_intent.* / charge.* 事件的 order_id 唯一来源。
    //    Session 级 metadata 不属于 PI/Charge；PI metadata 会在建 Charge 时复制过去
    expect(form.get('payment_intent_data[metadata][order_id]')).toBe('sk-1');
  });

  it('返回 copylink 入口（D-49：银行卡走托管页，不做卡表单）', async () => {
    const { provider } = build();
    const s = await provider.create(REQ);
    expect(s.entry.mode).toBe('copylink');
    if (s.entry.mode !== 'copylink') throw new Error('unreachable');
    expect(s.entry.url).toContain('checkout.stripe.com');
    expect(s.providerRef.startsWith('cs_test_')).toBe(true);
  });

  it('上游 5xx → 抛错并带上状态与订单号（排障要能定位到哪张单）', async () => {
    const { http, provider } = build();
    // ⚠️ failNext 只生效**一次**（这是它的语义），所以两条断言合并到同一次调用里；
    //    写两次 failNext 会让第二次请求真的成功，于是"抛错"这条断言变成假的
    http.failNext(500, '{"error":{"message":"upstream down"}}');
    await expect(provider.create(REQ)).rejects.toThrow(/HTTP 500[\s\S]*sk-1/);
  });

  it('响应缺 id/url → 抛（默认"响应一定合法"会让脏数据一路流到前端）', async () => {
    const { http, provider } = build();
    http.failNext(200, '{"id":"cs_1"}'); // 缺 url
    await expect(provider.create(REQ)).rejects.toThrow(/缺 id\/url/);
  });

  it('缺 options.secretKey / webhookSecret → **构造时**就抛（不等第一次调用）', () => {
    expect(() => build({ secretKey: '' })).toThrow(/options.secretKey/);
    expect(() => build({ webhookSecret: '' })).toThrow(/options.webhookSecret/);
    // options 整体缺失（`undefined`）也必须在构造期炸，不能等到第一次取字段才炸
    expect(() =>
      createStripeCheckoutProvider(
        { ...config(), options: undefined },
        {
          http: createFakeStripeHttp(),
          clock: NOW,
          idGen: systemIdGen,
        },
      ),
    ).toThrow(/options.secretKey/);
    // success_url / cancel_url 同样不能缺：缺了用户付完款会停在空白页
    expect(() => build({ successUrl: '' })).toThrow(/options.successUrl/);
    expect(() => build({ cancelUrl: '' })).toThrow(/options.cancelUrl/);
  });

  it('不配 apiBase → 走官方地址（不要默认发到测试环境）', async () => {
    const http = createFakeStripeHttp();
    const p = createStripeCheckoutProvider(
      { ...config(), options: { ...config().options, apiBase: undefined } },
      { http, clock: NOW, idGen: systemIdGen },
    );
    await p.create(REQ);
    expect(http.calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
  });
});

describe('parseWebhook（事件映射与验签细节）', () => {
  it('事件类型 → 归一化结果（逐条对，UNKNOWN 不猜）', async () => {
    const { http, provider } = build();
    // dispute 事件的 order_id 来自反查 PaymentIntent（dispute 对象上没有 metadata）
    http.givenPaymentIntent('pi_3P0000000000000000000000', { order_id: REQ.orderId });
    const expected: Array<[string, string]> = [
      [STRIPE_EVENT_TYPES.checkoutCompleted, 'succeeded'],
      [STRIPE_EVENT_TYPES.checkoutExpired, 'expired'],
      [STRIPE_EVENT_TYPES.checkoutAsyncSucceeded, 'succeeded'],
      [STRIPE_EVENT_TYPES.checkoutAsyncFailed, 'failed'],
      [STRIPE_EVENT_TYPES.paySucceeded, 'succeeded'],
      [STRIPE_EVENT_TYPES.payFailed, 'failed'],
      [STRIPE_EVENT_TYPES.payCanceled, 'expired'],
      [STRIPE_EVENT_TYPES.refundSucceeded, 'refunded'],
      [STRIPE_EVENT_TYPES.disputeCreated, 'disputed'],
    ];
    for (const [type, outcome] of expected) {
      const p = signed(type);
      const ev = await provider.parseWebhook(p.raw, p.headers);
      expect(ev.outcome, `${type} 应映射为 ${outcome}`).toBe(outcome);
      expect(ev.orderId).toBe(REQ.orderId);
      expect(ev.rawType).toBe(type);
    }
  });

  it('未知事件类型 → unknown（不猜，记录后由业务决定是否忽略）', async () => {
    const { provider } = build();
    // 用"前缀认识、但没在映射表里"的类型（`payment_intent.*` 家族里的一个未登记事件）
    const p = signed('payment_intent.requires_action');
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('unknown');
  });

  it('密钥轮换：多个 v1 中任一命中即通过', async () => {
    const { provider } = build();
    const p = signed('checkout.session.completed', { extra: 'v1=deadbeef' });
    await expect(provider.parseWebhook(p.raw, p.headers)).resolves.toMatchObject({
      outcome: 'succeeded',
    });
  });

  it('忽略 v0 干扰项（测试模式会多带一个 v0，把它当签名会永远验不过）', async () => {
    const { provider } = build();
    const p = signed('checkout.session.completed', { extra: 'v0=abcdef' });
    await expect(provider.parseWebhook(p.raw, p.headers)).resolves.toMatchObject({
      outcome: 'succeeded',
    });
  });

  it('签名正确但时间戳超出 5 分钟容差 → 40103（防重放）', async () => {
    const { provider } = build();
    const p = signed('checkout.session.completed', { t: NOW_SEC - 301 });
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toMatchObject({ code: 40103 });
    // 边界内侧（正好 300 秒）应当通过
    const ok = signed('checkout.session.completed', { t: NOW_SEC - 300 });
    await expect(provider.parseWebhook(ok.raw, ok.headers)).resolves.toMatchObject({
      outcome: 'succeeded',
    });
  });

  it('字段能缺就缺：id / type / currency / expires_at 缺失都有兜底，不炸也不假装', async () => {
    const { http, provider } = build();
    // 回调侧：没有 event id、没有 type、没有金额与币种
    const body = JSON.stringify({
      data: { object: { id: 'cs_1', metadata: { order_id: 'sk-1' } } },
    });
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), {
      [HEADER]: signStripePayload(body, SECRET, NOW_SEC),
    });
    expect(ev.eventId.startsWith('gen-')).toBe(true);
    expect(ev.rawType).toBe('unknown');
    expect(ev.outcome).toBe('unknown');
    expect(ev.amountMinor).toBeUndefined();
    expect(ev.currency).toBeUndefined();

    // 建会话侧：机构没给 expires_at → 不编一个出来（编出来的到期时间会误导关单）
    http.failNext(200, '{"id":"cs_2","url":"https://checkout.stripe.com/c/pay/cs_2"}');
    const s = await provider.create(REQ);
    expect(s.expiresAt).toBeUndefined();
  });

  it('metadata 里没有 order_id 时，回退到 client_reference_id（双保险，别只靠一处）', async () => {
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        client_reference_id: 'sk-fallback',
      }),
    );
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), {
      [HEADER]: signStripePayload(body, SECRET, NOW_SEC),
    });
    expect(ev.orderId).toBe('sk-fallback');
  });

  it('providerRef 回带：优先 id，其次 payment_intent，都没有则空串', async () => {
    const { provider } = build();
    const withPi = JSON.stringify(
      stripeEvent('charge.refunded', { metadata: { order_id: 'sk-1' }, payment_intent: 'pi_9' }),
    );
    const ev1 = await provider.parseWebhook(Buffer.from(withPi, 'utf8'), {
      [HEADER]: signStripePayload(withPi, SECRET, NOW_SEC),
    });
    expect(ev1.providerRef).toBe('pi_9');

    const bare = JSON.stringify(stripeEvent('charge.refunded', { metadata: { order_id: 'sk-1' } }));
    const ev2 = await provider.parseWebhook(Buffer.from(bare, 'utf8'), {
      [HEADER]: signStripePayload(bare, SECRET, NOW_SEC),
    });
    expect(ev2.providerRef).toBe('');
  });

  it('签名头存在但格式不对（没有 t= 或没有 v1）→ 40103', async () => {
    const { provider } = build();
    const bad = (header: string) => ({
      raw: Buffer.from('{}', 'utf8'),
      headers: { [HEADER]: header } as HeaderBag,
    });
    for (const h of ['v0=abcdef', 'foo=bar', 't=1700000000']) {
      await expect(provider.parseWebhook(bad(h).raw, bad(h).headers)).rejects.toMatchObject({
        code: 40103,
      });
    }
  });

  it('报文合法但整个 data 缺失 → 抛（拿不到单号就是没法处理，不能回 200 假装收到）', async () => {
    const { provider } = build();
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    await expect(provider.parseWebhook(Buffer.from(body, 'utf8'), headers)).rejects.toThrow(
      /取不到 order_id/,
    );
  });

  it('取不到 order_id → 抛（这是**我们**的缺陷：create 时没写 metadata）', async () => {
    const { provider } = build();
    // 造一条没有 metadata 的报文（模拟 create 时漏写）
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', objectForEvent('checkout.session.completed')),
    );
    const headers = { [STRIPE_SIGNATURE_HEADER]: signStripePayload(body, SECRET, NOW_SEC) };
    await expect(provider.parseWebhook(Buffer.from(body, 'utf8'), headers)).rejects.toThrow(
      /取不到 order_id/,
    );
  });
});

describe('parseWebhook：dispute 事件的 order_id 反查（体检 P1-7）', () => {
  /**
   * @why Dispute 对象结构上没有我们的 metadata（Stripe 不复制），链回订单的唯一字段是
   *      `payment_intent`。不修这个的真实后果：拒付事件全部 500 → 机构重发风暴，
   *      且 webhook_events 连"收到过"都没登记（解析先于登记）。
   */
  function signedDispute(pi = 'pi_3P0000000000000000000000') {
    const body = JSON.stringify(
      stripeEvent('charge.dispute.created', { ...dispute({ paymentIntent: pi }) }),
    );
    return {
      raw: Buffer.from(body, 'utf8'),
      headers: { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag,
    };
  }

  it('dispute 对象上没有 metadata → 反查 payment_intent 取回 order_id', async () => {
    const { http, provider } = build();
    http.givenPaymentIntent('pi_3P0000000000000000000000', { order_id: REQ.orderId });
    const p = signedDispute();
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('disputed');
    expect(ev.orderId).toBe(REQ.orderId);
    // 确实走了反查通道（而不是从别处碰巧取到）
    const gets = http.calls.filter((c) => c.method === 'GET');
    expect(gets.map((c) => c.url)).toEqual([
      'https://api.stripe.test/v1/payment_intents/pi_3P0000000000000000000000',
    ]);
  });

  it('反查失败（机构 5xx / 无此 PI）→ 抛，让机构按节奏重发（不回 200 假装收到）', async () => {
    const { provider } = build();
    // 不登记这个 PI：替身返回 404（有脾气的替身，见 fake-stripe-http）
    const p = signedDispute('pi_not_registered');
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toThrow(
      /反查 payment_intent 失败：HTTP 404/,
    );
  });

  it('反查到的 PI 上也没有 order_id → 抛（那才是**我们** create 时漏写的缺陷）', async () => {
    const { http, provider } = build();
    http.givenPaymentIntent('pi_3P0000000000000000000000', {});
    const p = signedDispute();
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toThrow(/上没有 order_id/);
  });

  it('dispute 对象连 payment_intent 字段都没有 → 抛原始"取不到 order_id"（不编不猜）', async () => {
    const { provider } = build();
    const bare = dispute();
    delete bare['payment_intent'];
    const body = JSON.stringify(stripeEvent('charge.dispute.created', bare));
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    await expect(provider.parseWebhook(Buffer.from(body, 'utf8'), headers)).rejects.toThrow(
      /取不到 order_id/,
    );
  });
});

describe('refund（原币全额退）', () => {
  /**
   * `refund` 在接口上是**可选**方法（不支持退款的通道没有它）。
   * @why 这里显式断言"stripe 必须有"：能力声明里写了 `supportsRefund: true`，
   *      若哪天漏了实现，注册表会在注册时拒绝，而这条用例让同样的事实**在单测里也红一次**
   *      ——两层拦截，是因为"能退款"这件事错了会造成真实资金损失。
   */
  function mustRefund(p: PaymentProvider): NonNullable<PaymentProvider['refund']> {
    const fn = p.refund;
    if (fn === undefined) throw new Error('stripe 声明 supportsRefund=true，必须实现 refund()');
    return fn;
  }

  it('按**原扣款币种**退（不是按今天汇率折成 JPY）', async () => {
    const { http, provider } = build();
    const r = await mustRefund(provider)({
      orderId: REQ.orderId,
      providerRef: 'pi_1',
      amountJpy: 12_000,
      currency: 'USD',
      amountInCurrency: 80,
      reason: '缺货',
    });
    expect(r.outcome).toBe('succeeded');
    const form = new URLSearchParams(http.calls.at(-1)?.body ?? '');
    // $80.00 → 8000 分；写成"按 JPY 退"就会变成 12000 分（$120），多退 50%
    expect(form.get('amount')).toBe('8000');
    expect(form.get('payment_intent')).toBe('pi_1');
    expect(form.get('metadata[order_id]')).toBe('sk-1');
  });

  it('退款状态 pending / failed 都要如实回带（不能一律当成成功）', async () => {
    const { http, provider } = build();
    const call = (status: string) => {
      http.failNext(200, JSON.stringify({ id: 're_1', status }));
      return mustRefund(provider)({
        orderId: REQ.orderId,
        providerRef: 'pi_1',
        amountJpy: 12_000,
        currency: 'JPY',
        amountInCurrency: 12_000,
        reason: '缺货',
      });
    };
    await expect(call('pending')).resolves.toMatchObject({ outcome: 'pending' });
    await expect(call('failed')).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('退款响应缺 id → 抛（默认"响应一定合法"会让"退款到底成功没有"变成未知）', async () => {
    const { http, provider } = build();
    http.failNext(200, '{"status":"succeeded"}');
    await expect(
      mustRefund(provider)({
        orderId: REQ.orderId,
        providerRef: 'pi_1',
        amountJpy: 12_000,
        currency: 'JPY',
        amountInCurrency: 12_000,
        reason: '缺货',
      }),
    ).rejects.toThrow(/缺 id/);
  });

  it('上游退款失败 → 抛错并带订单号', async () => {
    const { http, provider } = build();
    http.failNext(402);
    await expect(
      mustRefund(provider)({
        orderId: REQ.orderId,
        providerRef: 'pi_1',
        amountJpy: 12_000,
        currency: 'JPY',
        amountInCurrency: 12_000,
        reason: '缺货',
      }),
    ).rejects.toThrow(/退款失败/);
  });
});
