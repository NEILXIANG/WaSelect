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
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import type {
  ChannelConfig,
  HeaderBag,
  PaymentProvider,
  PaymentRequest,
} from '../../ports/payment.js';
import { ProviderRejectedError } from '../../ports/payment.js';
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
  DISPUTE_CREATED_SEC,
} from '../../../../test/factories/stripe.js';
import {
  createStripeCheckoutProvider,
  sessionOutcome,
  STRIPE_API_VERSION,
  STRIPE_MIN_SESSION_TTL_SEC,
  STRIPE_SESSION_MARGIN_SEC,
  STRIPE_SOURCE_TAG,
  STRIPE_VERSION_HEADER,
  STRIPE_SIGNATURE_HEADER as HEADER,
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
  amountMinor: 12_000,
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
function signed(
  type: string,
  opts: { t?: number; secret?: string; extra?: string; object?: Record<string, unknown> } = {},
) {
  const object = opts.object ?? objectForEvent(type);
  // ⚠️ dispute 对象**不能**硬塞 metadata：真实的 Dispute 上没有它（Stripe 不复制），
  //    塞进去等于把"取不到 order_id → 反查 PaymentIntent"这条路径从测试里抹掉——
  //    P1-7 之所以藏到体检才被发现，这层"贴心的合并"就是掩盖层之一。
  // ⚠️ 其余对象必须**同时**带上本系统标记（AJ-310）：`create()` 写进 Session / PI 的
  //    就是 `metadata.order_id` 与 `metadata.source` **两键**（B5 / AJ-198）。
  //    只塞 order_id 的样本在"归属判定前移到取单号之前"之后会被判成"非本系统的钱"
  //    ——那不是被测代码错了，是样本脱离了真实形状，会让走本助手的用例集体假红。
  //    想造"没有标记"的外部付款，请像 B5 那两条用例一样自己拼 body（不进本助手）。
  const sampleMeta = (object['metadata'] as Record<string, unknown> | undefined) ?? {};
  const realistic =
    object['object'] === 'dispute'
      ? object
      : {
          ...object,
          // ⚠️ `order_id` 沿用本助手原有的**覆盖**语义（样本自带的那个不保留，
          //    多数用例断言的就是 `REQ.orderId`）；其余样本键照带，再无条件补 `source`。
          metadata: { ...sampleMeta, order_id: REQ.orderId, source: STRIPE_SOURCE_TAG },
        };
  const body = JSON.stringify(stripeEvent(type, realistic));
  const header = signStripePayload(body, opts.secret ?? SECRET, opts.t ?? NOW_SEC);
  const withExtra = opts.extra === undefined ? header : `${header},${opts.extra}`;
  return { raw: Buffer.from(body, 'utf8'), headers: { [HEADER]: withExtra } as HeaderBag };
}

/**
 * 取 Stripe 请求的表单体（本文件 15 处共用）。
 *
 * @why 端口 `HttpRequest.body` 自 B1 起是 `string | Buffer`（对象存储要发二进制），
 *      而 Stripe 这一侧**恒为字符串**。这里显式只收字符串、其余按空串处理
 *      （随后的 `form.get(...)` 断言会红）——比 `String(body)` 好：后者会把图片字节
 *      变成一段乱码而断言照样跑，看不出"发出去的东西根本不是表单"。
 */
function formBody(call: { body?: string | Buffer | undefined } | undefined): URLSearchParams {
  const b = call?.body;
  return new URLSearchParams(typeof b === 'string' ? b : '');
}

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
    const form = formBody(http.calls[0]);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][currency]')).toBe('jpy');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('12000');
    expect(form.get('metadata[order_id]')).toBe('sk-1');
    expect(form.get('client_reference_id')).toBe('sk-1');
    // ⚠️ 体检 P1-7：payment_intent.* / charge.* 事件的 order_id 唯一来源。
    //    Session 级 metadata 不属于 PI/Charge；PI metadata 会在建 Charge 时复制过去
    expect(form.get('payment_intent_data[metadata][order_id]')).toBe('sk-1');
  });

  it('支付方式显式白名单只收卡（P2-NEW-1：Dashboard 开的异步方式会把"未付款 completed"放进来）', async () => {
    /**
     * @why 不限制 payment_method_types 时，托管页会展示 Dashboard 里启用的**所有**方式；
     *      其中异步方式（银行转账等）的 `checkout.session.completed` 是"用户提交了但还没付钱"。
     *      白名单 + parseWebhook 的 payment_status 校验是同一防线的两层。
     */
    const { http, provider } = build();
    await provider.create(REQ);
    const form = formBody(http.calls[0]);
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('payment_method_types[1]')).toBeNull();
  });

  /**
   * PAY3-03：Adaptive Pricing 是 **Dashboard 的账户级开关**（"今天关着"不构成"明天还关着"）。
   * @why 它一旦生效，客户在托管页看到的币种会被换成其所在地币种（加拿大客户看到 CAD 并付 CAD），
   *      而本系统落账认的是**我们建的那一笔**币种+金额（payments.charge_currency/charge_amount，
   *      mark-paid.ts 严格比对）→ 客户换币 = 比对失败 = 钱已收、订单卡在 pending_payment 直到过期
   *      → 只能人工退款。显式发 false 就是把"依赖两处外部配置"降成"依赖本文件这一行"。
   * @why 断言**报文里的实际值**而不是"配置里有这个字段"：后者会被"字段名拼错"骗过去，
   *      而拼错的字段名在真实机构上就是被当未知参数忽略——等于什么都没关。
   */
  it('显式关掉 Adaptive Pricing（PAY3-03：不赌 Dashboard 的账户级开关）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const form = formBody(http.calls[0]);
    expect(form.get('adaptive_pricing[enabled]')).toBe('false');
  });

  /**
   * @why 值是常量，所以不破坏 KD-9 的"同键同参"——这条用例把"关掉它不会让重试变成异参"
   *      这件事钉住（否则将来有人改成按订单/时间算的值，幂等键会开始撞 400）。
   */
  it('Adaptive Pricing 字段是常量：同一张单不同时刻重试，请求体逐字节相同（KD-9）', async () => {
    const withClock = (at: string) => {
      const http = createFakeStripeHttp();
      return {
        http,
        provider: createStripeCheckoutProvider(config(), {
          http,
          clock: fixedClock(at),
          idGen: systemIdGen,
        }),
      };
    };
    const early = withClock('2026-01-02T15:21:00.000Z');
    const late = withClock('2026-01-02T15:49:30.000Z');
    const req = { ...REQ, expiresAt: '2026-01-02T15:50:00.000Z' };
    await early.provider.create(req);
    await late.provider.create(req);
    expect(late.http.calls[0]?.body).toBe(early.http.calls[0]?.body);
    // 编码后的字段名（URLSearchParams 用 %5B/%5D）：拼错或被省略都会让这条红
    expect(late.http.calls[0]?.body).toContain('adaptive_pricing%5Benabled%5D=false');
  });

  it('出网固定 Stripe-Version（不固定则落账语义随 Dashboard 默认版本漂移）', async () => {
    /**
     * @why `parseWebhook` 读的是 Session 的 `currency` / `amount_total`。
     *      basil（2025-03-31）之前，Adaptive Pricing 生效时 `currency` 是**客户选的币种**，
     *      之后才是我们的 integration 币种（客户币种挪到 presentment_details）。
     *      不带这个头 = 用账户默认版本 = 这段语义由控制台的一项配置决定，而它不在版本控制里。
     */
    const { http, provider } = build();
    await provider.create(REQ);
    expect(http.calls[0]?.headers?.[STRIPE_VERSION_HEADER]).toBe(STRIPE_API_VERSION);
    // 钉住**字面值**：升级版本是一次有意为之的改动，必须让这条用例先红一次
    expect(STRIPE_API_VERSION).toBe('2025-03-31.basil');
  });

  /**
   * D-49 明定的会话参数（三审 A3）：账单地址必收、3DS 强制、会话到期跟订单到期走。
   * @why 三者都是"缺了不报错、只在拒付/迟到付款那天才付代价"的参数：
   *      不强制 3DS → 拒付责任在我方（D-50 拒付防线）；不收账单地址 → 风控与 AVS 无依据；
   *      不设 expires_at → Stripe 默认 24h，订单 30 分钟就关了、用户 23 小时后还能付成功（D-33 迟到付款）。
   */
  it('D-49：账单地址必收、3DS any、expires_at = 订单到期 + 30 分钟下限 + 2 分钟余量（KD-9）', async () => {
    const { http, provider } = build();
    await provider.create({ ...REQ, expiresAt: '2026-01-02T15:50:00.000Z' });
    const form = formBody(http.calls[0]);
    expect(form.get('billing_address_collection')).toBe('required');
    expect(form.get('payment_method_options[card][request_three_d_secure]')).toBe('any');
    // 数字取自生产常量（单一来源）：写死 30*60 的话，改了下限这条会"绿着"骗人
    expect(form.get('expires_at')).toBe(
      String(
        Date.parse('2026-01-02T15:50:00.000Z') / 1000 +
          STRIPE_MIN_SESSION_TTL_SEC +
          STRIPE_SESSION_MARGIN_SEC,
      ),
    );
  });

  it('订单到期带毫秒 → 向上取整到秒再加下限（不提前关会话）', async () => {
    const { http, provider } = build();
    await provider.create({ ...REQ, expiresAt: '2026-01-02T16:30:00.500Z' });
    const form = formBody(http.calls[0]);
    expect(form.get('expires_at')).toBe(
      String(
        Math.ceil(Date.parse('2026-01-02T16:30:00.500Z') / 1000) +
          STRIPE_MIN_SESSION_TTL_SEC +
          STRIPE_SESSION_MARGIN_SEC,
      ),
    );
  });

  it('KD-9：同一张单在不同时刻重试建会话 → 发给 Stripe 的请求体与幂等键逐字节相同（同键同参，机构幂等才有效）', async () => {
    const withClock = (at: string) => {
      const http = createFakeStripeHttp();
      return {
        http,
        provider: createStripeCheckoutProvider(config(), {
          http,
          clock: fixedClock(at),
          idGen: systemIdGen,
        }),
      };
    };
    const early = withClock('2026-01-02T15:21:00.000Z');
    const late = withClock('2026-01-02T15:49:30.000Z');
    const req = { ...REQ, expiresAt: '2026-01-02T15:50:00.000Z' };
    await early.provider.create(req);
    await late.provider.create(req);
    expect(late.http.calls[0]?.body).toBe(early.http.calls[0]?.body);
    expect(late.http.calls[0]?.headers?.['idempotency-key']).toBe(
      early.http.calls[0]?.headers?.['idempotency-key'],
    );
    // 且在最晚的可付时刻（到期前 30 秒）仍满足 Stripe 的"创建后至少 30 分钟"
    const sent = Number(formBody(late.http.calls[0]).get('expires_at'));
    expect(sent - Date.parse('2026-01-02T15:49:30.000Z') / 1000).toBeGreaterThan(
      STRIPE_MIN_SESSION_TTL_SEC,
    );
  });

  it('expiresAt 不是合法 ISO 时间 → 建会话前抛错（发 NaN 给机构会得到含混的 400）', async () => {
    const { http, provider } = build();
    await expect(provider.create({ ...REQ, expiresAt: 'not-a-date' })).rejects.toThrow(
      /expiresAt 不是合法 ISO/,
    );
    expect(http.calls.length).toBe(0);
  });

  it('未传 expiresAt 时不发 expires_at（由机构默认；I1 建单必传，此处只保证不发坏值）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const form = formBody(http.calls[0]);
    expect(form.get('expires_at')).toBeNull();
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

  /**
   * B3 / AJ-199：抛的必须是 `ProviderRejectedError`，不能是普通 Error。
   * @why 业务核心靠这个类型分辨"机构给了确定答复"与"结果未知"——前者换幂等键、后者不换。
   *      类型不对 = 换键逻辑永远走不到 = 这张单在机构故障恢复后仍然付不了（B3 的原始症状）。
   */
  it('上游 5xx → 抛 `ProviderRejectedError`（业务层靠这个类型决定换不换幂等键）', async () => {
    const { http, provider } = build();
    http.failNext(500, '{"error":{"message":"upstream down"}}');
    await expect(provider.create(REQ)).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  /**
   * @why 替身现在会**按幂等键回放 5xx**（真 Stripe 保留 ≥24 小时）。
   *      没有这条脾气时，"首次 5xx → 再次发起"在测试里会成功，在真 Stripe 上会一直失败到订单过期。
   *      换一把键就能成功——这正是 B3 的修法；不换键必须仍然失败，否则替身没脾气、B3 会假绿。
   */
  it('🔴 AJ-414 409 idempotency_key_in_use（同键仍在处理中）→ 抛普通 Error 而**不是** ProviderRejectedError（结果未知，不换键）', async () => {
    const { http, provider } = build();
    http.failNext(409, '{"error":{"code":"idempotency_key_in_use","message":"in progress"}}');
    const err = await provider.create(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderRejectedError);
    expect((err as Error).message).toMatch(/idempotency_key_in_use/);
  });

  it('同键重放 5xx（替身模拟机构缓存）；换键才建得出来', async () => {
    const { http, provider } = build();
    http.failNext(500, '{"error":{"message":"upstream down"}}');
    await expect(provider.create(REQ)).rejects.toBeInstanceOf(ProviderRejectedError);
    // 同键第二次：机构回放的是**缓存的那次失败**，不是"再试一次"
    await expect(provider.create(REQ)).rejects.toBeInstanceOf(ProviderRejectedError);
    // 换键（业务层的 -f1）：这才是 B3 修法能救回来的那一次
    const s = await provider.create({ ...REQ, idempotencyKey: `${REQ.idempotencyKey}-f1` });
    expect(s.providerRef.startsWith('cs_test_')).toBe(true);
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
    // B5 / AJ-198：替身里的 PI 必须带上本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
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
      [STRIPE_EVENT_TYPES.disputeClosed, 'dispute_closed'],
    ];
    for (const [type, outcome] of expected) {
      const p = signed(type);
      const ev = await provider.parseWebhook(p.raw, p.headers);
      expect(ev.outcome, `${type} 应映射为 ${outcome}`).toBe(outcome);
      expect(ev.orderId).toBe(REQ.orderId);
      expect(ev.rawType).toBe(type);
    }
  });

  it('🔴 支付成功事件带**事件生成时刻** eventAtMs（取 envelope 的 created；M-01 据此判迟到）', async () => {
    const { provider } = build();
    const p = signed('checkout.session.completed');
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('succeeded');
    // 样本 envelope 的 created = 1_700_000_000（见上一条 @measured）
    expect(ev.eventAtMs).toBe(1_700_000_000 * 1000);
  });

  it('🔴 拒付事件带**开案时刻**（取 Dispute 对象的 created，不是事件 envelope 的）', async () => {
    const { http, provider } = build();
    // B5 / AJ-198：替身里的 PI 必须带上本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
    const p = signed(STRIPE_EVENT_TYPES.disputeCreated);
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('disputed');
    // @measured 样本里 envelope 的 created = 1_700_000_000、Dispute 的 = 1_690_000_000；
    //           取错的话这里会拿到前者（差 10_000_000 秒 ≈ 115 天），举证窗口被算短。
    expect(ev.occurredAtMs).toBe(DISPUTE_CREATED_SEC * 1000);
    expect(ev.occurredAtMs).not.toBe(1_700_000_000 * 1000);
  });

  it('🔴 结案事件的**结果**在对象 status 上，事件类型本身不带（won / lost 必须能传出去）', async () => {
    /**
     * @why Stripe 的 `charge.dispute.closed` 只说"结案了"，赢了还是输了在
     *      `data.object.status`（`won` / `lost`）。只看事件类型的话，
     *      结案只能落成一个"已关闭"，风控页就答不出"这单最后是赔了还是保住了"——
     *      而那正是运营要拿它决定"要不要继续追究"的依据。
     */
    const { http, provider } = build();
    // B5 / AJ-198：替身里的 PI 必须带上本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
    for (const status of ['won', 'lost'] as const) {
      const p = signed(STRIPE_EVENT_TYPES.disputeClosed, { object: dispute({ status }) });
      const ev = await provider.parseWebhook(p.raw, p.headers);
      expect(ev.outcome).toBe('dispute_closed');
      expect(ev.disputeStatus).toBe(status);
    }
  });

  it('开案事件同样带 disputeStatus（让落账方知道"这条拒付现在什么状态"）', async () => {
    const { http, provider } = build();
    // B5 / AJ-198：替身里的 PI 必须带上本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
    const p = signed(STRIPE_EVENT_TYPES.disputeCreated);
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.disputeStatus).toBe('warning_needs_response');
  });

  it('非拒付对象（charge / session）即使有 status 也**不带** disputeStatus（不混成一团）', async () => {
    /**
     * @why `charge` 与 `checkout.session` 也有 `status` 字段，但那是**支付**状态。
     *      不分对象地回带，消费方就会拿到一个"不知道是哪种状态"的 status——
     *      于是"支付失败"可能被当成"拒付输了"。
     */
    const { provider } = build();
    const p = signed(STRIPE_EVENT_TYPES.refundSucceeded);
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('refunded');
    expect(ev.disputeStatus).toBeUndefined();
  });

  it('机构没给 created → 不带 occurredAtMs（让"没给"暴露给消费方，不静默补当前时间）', async () => {
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        metadata: { order_id: REQ.orderId },
      }),
    );
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), {
      [HEADER]: signStripePayload(body, SECRET, NOW_SEC),
    });
    expect(ev.occurredAtMs).toBeUndefined();
  });

  it('未知事件类型 → unknown（不猜，记录后由业务决定是否忽略）', async () => {
    const { provider } = build();
    // 用"前缀认识、但没在映射表里"的类型（`payment_intent.*` 家族里的一个未登记事件）
    const p = signed('payment_intent.requires_action');
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('unknown');
  });

  it('checkout.session.completed 但 payment_status=unpaid → unknown（P2-NEW-1：异步方式的"已提交未付款"不能置 paid）', async () => {
    /**
     * @why 官方口径：异步支付方式下 completed ≠ 已收款，要等 async_payment_succeeded。
     *      create() 的白名单（只收卡）是第一层，这里是第二层——Dashboard 配置漂移伤不到落账。
     */
    const { provider } = build();
    const object = {
      ...objectForEvent('checkout.session.completed'),
      payment_status: 'unpaid',
      metadata: { order_id: REQ.orderId },
    };
    const body = JSON.stringify(stripeEvent('checkout.session.completed', object));
    const p = {
      raw: Buffer.from(body, 'utf8'),
      headers: { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag,
    };
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.rawType).toBe('checkout.session.completed');
  });

  it('时间戳不是数字（t=NaN）→ 40103（P3-12：任何与 NaN 的比较都是 false，容差会被静默绕过）', async () => {
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', {
        ...objectForEvent('checkout.session.completed'),
        metadata: { order_id: REQ.orderId },
      }),
    );
    // signStripePayload 直接插值 `${t}`：传 NaN 造出 "t=NaN" 的合法签名头
    const p = {
      raw: Buffer.from(body, 'utf8'),
      headers: { [HEADER]: signStripePayload(body, SECRET, Number('not-a-number')) } as HeaderBag,
    };
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toMatchObject({
      code: 40103,
      details: { reason: 'stripe_timestamp_malformed' },
    });
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

  /**
   * 容差必须**双向**（三审变异 U36 存活：`Math.abs` 改成单向"只拦过旧"时全绿）。
   * @why 未来时间戳同样是重放素材：攻击者拿到一份签名报文后，等到它"变旧"之前的窗口
   *      并不受"只拦过旧"保护；且两端时钟差超过 300 秒本就是故障，不该静默放行。
   */
  it('时间戳在未来超过容差同样 40103（容差是双向的）', async () => {
    const { provider } = build();
    const p = signed('checkout.session.completed', { t: NOW_SEC + 301 });
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toMatchObject({
      code: 40103,
      details: { reason: 'stripe_timestamp_expired' },
    });
  });

  /**
   * 验签必须对**原始字节**做 HMAC（三审 S4）：`raw.toString('utf8')` 再 update 会把非法
   * UTF-8 字节替换成 U+FFFD，签名对应的原文与我们算的不再是同一串字节。
   * 结果是 fail-closed（拒绝），没有安全问题，但偏离官方"raw request body"口径，
   * 且这类报文会被判成 40103 而不是 40001，排障方向指向密钥而不是报文。
   */
  it('原始字节含非法 UTF-8 时按字节验签仍能通过（fail-closed 改为按官方口径）', async () => {
    const { provider } = build();
    const bytes = Buffer.concat([
      Buffer.from('{"id":"evt_x","type":"noop","data":{"object":{}}}'),
      Buffer.from([0xff]),
    ]);
    const header = signStripePayload(bytes, SECRET, NOW_SEC);
    // JSON 解析会失败 → 40001；若验签先按 utf8 重编码失败会得到 40103（错误方向）
    await expect(
      provider.parseWebhook(bytes, { [HEADER]: header } as HeaderBag),
    ).rejects.toMatchObject({ code: 40001 });
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
        // ⚠️ 必须带本系统标记：归属判定先于取单号（AJ-310），没有标记的会话一律"非本系统"，
        //    `client_reference_id` 回退只在"**我们的**会话上 metadata 恰好缺 order_id"时成立。
        metadata: { source: STRIPE_SOURCE_TAG },
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

  it('签名头是空字符串 → 40103 stripe_no_signature（与缺头同判，不进入解析）', async () => {
    const { provider } = build();
    await expect(
      provider.parseWebhook(Buffer.from('{}', 'utf8'), { [HEADER]: '' } as HeaderBag),
    ).rejects.toMatchObject({ code: 40103, details: { reason: 'stripe_no_signature' } });
  });

  it('v1 长度正确但内容不对 → 40103 stripe_signature_mismatch（走到 timingSafeEqual 那一步）', async () => {
    const { provider } = build();
    const raw = Buffer.from('{"id":"evt_x","type":"charge.refunded"}', 'utf8');
    const t = Math.floor(NOW.now().getTime() / 1000);
    const wrong = 'a'.repeat(64); // HMAC-SHA256 hex 恰好 64 位
    await expect(
      provider.parseWebhook(raw, { [HEADER]: `t=${t},v1=${wrong}` } as HeaderBag),
    ).rejects.toMatchObject({ code: 40103, details: { reason: 'stripe_signature_mismatch' } });
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

  it('报文合法但整个 data 缺失 → unknown + 空单号（B5 修正：抛 500 会把端点拖向停用）', async () => {
    /**
     * @why 旧断言是"抛"——那是 B5 要修的错误方向：一个我们根本无法归属的报文，
     *      抛错只会让 Stripe 按退避重发数天。收下并记 `ignored:unknown`，
     *      "有东西进来了但我们没处理"在 `webhook_events` 里看得见，比 500 有用。
     */
    const { provider } = build();
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.orderId).toBe('');
  });

  it.each(['balance.available', 'payout.paid', 'charge.refunded', 'payment_intent.canceled'])(
    '与订单无关 / 非落账事件缺 order_id（%s）→ unknown + orderId 空串，不抛（否则 Stripe 无限重发直至停用端点）',
    async (type) => {
      const { provider } = build();
      const body = JSON.stringify({
        id: `evt_${type}`,
        type,
        data: { object: { object: 'x', id: 'obj_1' } },
      });
      const headers = { [STRIPE_SIGNATURE_HEADER]: signStripePayload(body, SECRET, NOW_SEC) };
      const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
      expect(ev).toMatchObject({ outcome: 'unknown', orderId: '', rawType: type });
    },
  );

  it('B5 修正：完全没有我们的标记 → 按"非本系统的付款"收下（**不再**抛）', async () => {
    /**
     * @why 旧断言"取不到 order_id 就抛"**没有区分两种完全不同的现场**：
     *      ① 账户里非本系统收的款（Payment Link / Dashboard / Invoice）——不是我们的钱，抛了就是 500；
     *      ② 我们建的单却漏写了 metadata——那才是我们的缺陷。
     *      有了 `metadata.source` 标记之后两者才分得开：没标记归①，有标记却没单号归②。
     *      ⚠️ 这条改成"不抛"之后，**② 的兜底靠下一个用例 + create 侧"标记必须发出去"那条**
     *      ——两边合起来才等价于旧的守护，缺任何一边就会出现"我们漏写 metadata 却静默丢单"。
     */
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', objectForEvent('checkout.session.completed')),
    );
    const headers = { [STRIPE_SIGNATURE_HEADER]: signStripePayload(body, SECRET, NOW_SEC) };
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.orderId).toBe('');
  });

  it('有我们的标记却取不到 order_id → 抛（那才是**我们** create 写漏了，必须看得见）', async () => {
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent('checkout.session.completed', {
        ...objectForEvent('checkout.session.completed'),
        metadata: { source: STRIPE_SOURCE_TAG }, // 是我们建的，但没有 order_id
      }),
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
    // B5 / AJ-198：替身里的 PI 必须带上本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
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
      /反查 payment_intents 失败：HTTP 404/,
    );
  });

  it('反查到的 PI 上也没有 order_id → 抛（那才是**我们** create 时漏写的缺陷）', async () => {
    const { http, provider } = build();
    // 有我们的标记、却没有 order_id ⇒ **我们** create 写漏了，必须抛（B5 保留这条不放宽）
    http.givenPaymentIntent('pi_3P0000000000000000000000', { source: STRIPE_SOURCE_TAG });
    const p = signedDispute();
    await expect(provider.parseWebhook(p.raw, p.headers)).rejects.toThrow(/上没有 order_id/);
  });

  it('🔴 B5：非本系统收的款（Payment Link / Dashboard 收款）的 completed → unknown + 空单号，不抛', async () => {
    /**
     * @why 旧实现：`checkout.session.completed` 若取不到 order_id 一律**抛** → 500。
     *      而运营用 Payment Link / Dashboard / Invoice 收的款也会打到同一个端点，
     *      它们理所当然没有我们的 metadata。Stripe 对持续失败的端点会**停用**——
     *      届时真实订单的回调一起收不到（钱收了、订单永远 pending_payment）。
     *      判据是 `metadata.source`：**没有标记 = 不是我们的钱**。
     */
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent(STRIPE_EVENT_TYPES.checkoutCompleted, {
        ...objectForEvent(STRIPE_EVENT_TYPES.checkoutCompleted),
        metadata: {}, // 没有 source、没有 order_id
      }),
    );
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(ev.outcome).toBe('unknown'); // 空单号一律 unknown ⇒ 管线 200 + ignored 留痕
    expect(ev.orderId).toBe('');
  });

  it('🔴 B5：非本系统的拒付（PI 上没有我们的标记）→ unknown + 空单号，不抛', async () => {
    const { http, provider } = build();
    http.givenPaymentIntent('pi_foreign_000000000000000', { order_id: 'someone-elses-order' });
    const p = signedDispute('pi_foreign_000000000000000');
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.orderId).toBe('');
  });

  it('B5：create 把本系统标记写进 Session 与 PaymentIntent 的 metadata（判据的两端都要发）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const form = formBody(http.calls[0]);
    expect(form.get('metadata[source]')).toBe(STRIPE_SOURCE_TAG);
    // ⚠️ PI 那份才是 payment_intent.* / charge.* 事件的判据来源，漏了它那批事件全部变成"非本系统"
    expect(form.get('payment_intent_data[metadata][source]')).toBe(STRIPE_SOURCE_TAG);
  });

  /**
   * 🔴 AJ-311（第二轮审查 PAY2-02 的修法）：`payment_intent` 为空的 dispute 走 **charge** 反查。
   *
   * @why @measured(docs.stripe.com/api/disputes/object, 2026-09-30)：Dispute 的
   *      `payment_intent` 与 `charge` **都可空**，官方示例对象里 `payment_intent` 就是 null。
   *      不经 PaymentIntent 的收款（旧 Charges API / 部分非卡支付方式）被拒付时只有 `charge`；
   *      旧实现此时两条"收下"分支都把 dispute 排除在外 → 一律抛 → **每一条拒付事件都回 500**
   *      → 机构重发约三天 → 端点被停用。本系统自己的付款一定有 PI，这一条补的是
   *      "账户里别人的钱被拒付"那半边——它不该以 500 的形式把端点拖垮。
   */
  it('🔴 dispute 上没有 payment_intent（只有 charge）→ 反查 charge 取回 order_id，不抛', async () => {
    const { http, provider } = build();
    http.givenCharge('ch_3P0000000000000000000000', {
      order_id: REQ.orderId,
      source: STRIPE_SOURCE_TAG,
    });
    const legacy = dispute();
    delete legacy['payment_intent'];
    const body = JSON.stringify(stripeEvent('charge.dispute.created', legacy));
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(ev.outcome).toBe('disputed');
    expect(ev.orderId).toBe(REQ.orderId);
    // 确实走的是 charge 那条反查通道（不是从别处碰巧取到）
    expect(http.calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      'https://api.stripe.test/v1/charges/ch_3P0000000000000000000000',
    ]);
  });

  it('🔴 非本系统的扣款被拒付（charge 上没有我们的标记）→ unknown + 空单号，不抛', async () => {
    const { http, provider } = build();
    http.givenCharge('ch_foreign_00000000000000000', { order_id: 'someone-elses-order' });
    const legacy = dispute();
    delete legacy['payment_intent'];
    legacy['charge'] = 'ch_foreign_00000000000000000';
    const body = JSON.stringify(stripeEvent('charge.dispute.created', legacy));
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), headers);
    expect(ev.outcome).toBe('unknown');
    expect(ev.orderId).toBe('');
  });

  it('dispute 上 payment_intent 与 charge 都没有 → 抛（链不回任何可查对象，不能悄悄 ignored）', async () => {
    const { provider } = build();
    const bare = dispute();
    delete bare['payment_intent'];
    delete bare['charge'];
    const body = JSON.stringify(stripeEvent('charge.dispute.created', bare));
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    await expect(provider.parseWebhook(Buffer.from(body, 'utf8'), headers)).rejects.toThrow(
      /取不到 order_id/,
    );
  });
});

/**
 * 🔴 AJ-310（第二轮审查 PAY2-01 的修法）：**归属判定必须在取单号之前**。
 *
 * @why 旧实现先调 `orderIdOf(obj)`：只要对象上有 `metadata.order_id` 或
 *      `client_reference_id` 就当成本系统订单，**永远不问 `isOurs`**。
 *      于是 B5 那条"没标记 = 非本系统的钱"被绕开了两条真实路径——
 *      下面两条用例各钉一条。它们的后果与 B5 要堵的完全一样：
 *      进落账管线 → `markOrderPaid` 抛 40400 → 宽限期内每次投递回 503，
 *      过宽限期落 `unmatched:order_not_found` 并打 error 级 `callback_unmatched`
 *      （"钱到单未付"的假告警，每一笔外部付款一条，会淹没真告警）。
 */
describe('parseWebhook：归属判定先于取单号（AJ-310）', () => {
  /** 手工拼一条"没有本系统标记"的事件报文（不走 signed 助手——它会注入标记）。 */
  function foreignBody(
    type: string,
    object: Record<string, unknown>,
  ): {
    raw: Buffer;
    headers: HeaderBag;
  } {
    const body = JSON.stringify(stripeEvent(type, object));
    return {
      raw: Buffer.from(body, 'utf8'),
      headers: { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag,
    };
  }

  it('🔴 外部付款带 client_reference_id（付款人可经 URL 指定）但没有标记 → unknown，不进管线', async () => {
    const { provider } = build();
    const p = foreignBody(STRIPE_EVENT_TYPES.checkoutCompleted, {
      ...objectForEvent(STRIPE_EVENT_TYPES.checkoutCompleted),
      // ⚠️ 这个值在 Payment Link 场景下由**付款人**经 URL 指定（?client_reference_id=…），
      //    填成本系统单号是完全做得到的
      client_reference_id: REQ.orderId,
      metadata: {},
    });
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.orderId).toBe('');
    expect(ev.outcome).toBe('unknown');
  });

  it('🔴 同一账户上另一套集成写了 metadata.order_id 但没有标记 → unknown，不进管线', async () => {
    const { provider } = build();
    const p = foreignBody(STRIPE_EVENT_TYPES.checkoutCompleted, {
      ...objectForEvent(STRIPE_EVENT_TYPES.checkoutCompleted),
      // `order_id` 是极常见的键名，另一套集成完全可能用它
      metadata: { order_id: 'shopify-1001' },
    });
    const ev = await provider.parseWebhook(p.raw, p.headers);
    expect(ev.orderId).toBe('');
    expect(ev.outcome).toBe('unknown');
  });

  /**
   * @why 旧实现里这条缺陷**只对 succeeded 类事件**成立：非 succeeded 类事件会先被
   *      "按事件类型放行"那条分支吞掉（有标记却取不到单号 → 静默 unknown）。
   *      判据前移之后，"有标记却取不到 order_id = 自己写漏了"对所有事件类型成立。
   */
  it('🔴 有本系统标记却取不到 order_id 的**非 succeeded** 事件也抛（旧实现会静默吞掉）', async () => {
    const { provider } = build();
    const body = JSON.stringify(
      stripeEvent(STRIPE_EVENT_TYPES.checkoutExpired, {
        ...objectForEvent(STRIPE_EVENT_TYPES.checkoutExpired),
        metadata: { source: STRIPE_SOURCE_TAG }, // 有标记，但没有 order_id
      }),
    );
    const headers = { [HEADER]: signStripePayload(body, SECRET, NOW_SEC) } as HeaderBag;
    await expect(provider.parseWebhook(Buffer.from(body, 'utf8'), headers)).rejects.toThrow(
      /取不到 order_id/,
    );
  });

  it('退款也带本系统标记：我们自己发起的退款事件能链回订单（不是"非本系统的钱"）', async () => {
    const { http, provider } = build();
    await provider.create(REQ);
    const { refund } = provider;
    if (refund === undefined) throw new Error('stripe 必须支持退款');
    await refund.call(provider, {
      orderId: REQ.orderId,
      providerRef: 'cs_test_0001',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: 'test',
    });
    const form = formBody(http.calls.at(-1));
    expect(form.get('metadata[source]')).toBe(STRIPE_SOURCE_TAG);
    expect(form.get('metadata[order_id]')).toBe(REQ.orderId);
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
      amountMinor: 8_000,
      reason: '缺货',
    });
    expect(r.outcome).toBe('succeeded');
    const form = formBody(http.calls.at(-1));
    // $80.00 = 8000 分（端口口径已是整数最小单位，适配器只透传）；
    // 写成"按 JPY 退"就会变成 12000 分（$120），多退 50%
    expect(form.get('amount')).toBe('8000');
    expect(form.get('payment_intent')).toBe('pi_1');
    expect(form.get('metadata[order_id]')).toBe('sk-1');
  });

  it('退款带机构侧幂等键 refund:{orderId}（P2-NEW-2：POST 超时后的人工重试不会退两次）', async () => {
    /**
     * @why 出站红线是"无幂等键的 POST 超时/5xx 一律不重试"——不带键时超时 = Stripe 侧
     *      状态未知且我们不敢重发，只能靠人工再点。带上确定性键后，人工重试落到同一键，
     *      Stripe 返回第一次的退款而不是再退一次（MVP 全额退、一单一退，orderId 即幂等粒度）。
     */
    const { http, provider } = build();
    await mustRefund(provider)({
      orderId: REQ.orderId,
      providerRef: 'pi_1',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: '缺货',
    });
    expect(http.calls.at(-1)?.headers?.['idempotency-key']).toBe(`refund:${REQ.orderId}`);
  });

  /**
   * AJ-383：部分退款**每笔一把键**（`refund-part:<部分退款 id>`），与整单退款的 `refund:<orderId>` 分开。
   * @why 同一订单可以先后退好几笔：若沿用 `refund:<orderId>`，第二笔会落到第一笔的键上，
   *      Stripe 回放第一笔的结果 ⇒ 第二笔"成功"了却一分钱没退。金额照传（部分退款就靠它）。
   */
  it('🔴 部分退款：键为 refund-part:{partialRefundId}，金额为本笔金额（不是实收）', async () => {
    const { http, provider } = build();
    await mustRefund(provider)({
      orderId: REQ.orderId,
      providerRef: 'pi_1',
      amountJpy: 0,
      currency: 'USD',
      amountMinor: 1_000,
      reason: '缺一件',
      partialRefundId: 'rf-abc',
    });
    const last = http.calls.at(-1);
    expect(last?.headers?.['idempotency-key']).toBe('refund-part:rf-abc');
    expect(new URLSearchParams(String(last?.body)).get('amount')).toBe('1000');
  });

  /**
   * B7 / AJ-191：metadata 的值有长度上限，超了机构拒这一整笔退款。
   * @why 断言的是**报文里的实际值**而不是"有没有调用 clip"：后者是拿被测对象内部
   *      状态自证（§2 第 21 条），把 `clipRefundReason` 换成恒等函数它照样绿。
   * @why 同时断言"截断是前缀、且两次调用一致"：KD-4 要求重试同键同参，
   *      若截断不确定（比如按时间/长度抖动），重试就是异参，机构直接 400。
   */
  it('超限的理由在报文里被**确定性**截断（B7：超长会被机构拒）', async () => {
    const { http, provider } = build();
    const long = '理'.repeat(REFUND_REASON_MAX_LENGTH + 200);
    const send = () =>
      mustRefund(provider)({
        orderId: REQ.orderId,
        providerRef: 'pi_1',
        amountJpy: 12_000,
        currency: 'JPY',
        amountMinor: 12_000,
        reason: long,
      });
    await send();
    const first = formBody(http.calls.at(-1)).get('metadata[reason]');
    expect(first).not.toBeNull();
    expect(first?.length).toBe(REFUND_REASON_MAX_LENGTH);
    expect(long.startsWith(first ?? '')).toBe(true); // 是前缀，不是随便切一段
    await send();
    const second = formBody(http.calls.at(-1)).get('metadata[reason]');
    expect(second).toBe(first); // 同一输入 → 同一输出（重试同键同参）
  });

  it('未超限的理由一字不动（截断只在存量脏数据上生效）', async () => {
    const { http, provider } = build();
    const reason = '缺货，客户要求整单退款';
    await mustRefund(provider)({
      orderId: REQ.orderId,
      providerRef: 'pi_1',
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason,
    });
    expect(formBody(http.calls.at(-1)).get('metadata[reason]')).toBe(reason);
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
        amountMinor: 12_000,
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
        amountMinor: 12_000,
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
        amountMinor: 12_000,
        reason: '缺货',
      }),
    ).rejects.toThrow(/退款失败/);
  });
});

describe('refund 状态映射 / 重新发起 / 状态查询（F-03，AJ-178）', () => {
  const REFUND = {
    orderId: REQ.orderId,
    providerRef: 'pi_1',
    amountJpy: 12_000,
    currency: 'JPY',
    amountMinor: 12_000,
    reason: '缺货',
  };
  const refundOf = (p: PaymentProvider) => {
    const fn = p.refund;
    if (fn === undefined) throw new Error('stripe 必须实现 refund()');
    return fn;
  };
  const statusOf = (p: PaymentProvider) => {
    const fn = p.refundStatus;
    if (fn === undefined) throw new Error('stripe 声明 supportsRefund，必须实现 refundStatus()');
    return fn;
  };

  /**
   * @measured(docs.stripe.com/api/refunds/object, 2026-09-29)：Refund.status 取值
   *   `pending` / `requires_action` / `succeeded` / `failed` / `canceled`（nullable）。
   * @why 只有 failed / canceled 算"机构确认失败"——那会让下一次重试**换新幂等键**重新发起；
   *      认不出的状态一律 pending（等查询 / 对账），不猜成失败：猜错的代价是对一笔
   *      可能已在途的退款再发一笔。
   */
  it.each([
    ['succeeded', 'succeeded'],
    ['pending', 'pending'],
    ['requires_action', 'pending'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
    ['a_future_status', 'pending'],
  ])('POST 回 status=%s → outcome=%s', async (status, outcome) => {
    const { http, provider } = build();
    http.failNext(200, JSON.stringify({ id: 're_1', object: 'refund', status }));
    await expect(refundOf(provider)(REFUND)).resolves.toMatchObject({ outcome, refundRef: 're_1' });
  });

  it('attempt 缺省 / 0 → 键 refund:{orderId}；attempt=2 → 键 refund:{orderId}:2（确认失败后才换键）', async () => {
    const { http, provider } = build();
    // 首笔被机构判失败（替身按真规则：同一 PI 上还有未失败的退款时，新键会被拒 charge_already_refunded）
    http.nextRefundStatus('failed');
    await expect(refundOf(provider)(REFUND)).resolves.toMatchObject({ outcome: 'failed' });
    await expect(refundOf(provider)({ ...REFUND, attempt: 0 })).resolves.toMatchObject({
      outcome: 'failed', // 同键 = 机构缓存的首次结果：不换键就永远拿回这笔失败
    });
    await expect(refundOf(provider)({ ...REFUND, attempt: 2 })).resolves.toMatchObject({
      outcome: 'succeeded',
    });
    const keys = http.calls
      .filter((c) => c.url.endsWith('/v1/refunds'))
      .map((c) => c.headers?.['idempotency-key']);
    expect(keys).toEqual([
      `refund:${REQ.orderId}`,
      `refund:${REQ.orderId}`,
      `refund:${REQ.orderId}:2`,
    ]);
  });

  it('refundStatus：GET /v1/refunds/{id}（带鉴权、不带幂等键），按同一张表映射', async () => {
    const { http, provider } = build();
    for (const [status, outcome] of [
      ['succeeded', 'succeeded'],
      ['pending', 'pending'],
      ['requires_action', 'pending'],
      ['failed', 'failed'],
      ['canceled', 'failed'],
      ['a_future_status', 'pending'],
    ] as const) {
      http.failNext(200, JSON.stringify({ id: 're_9', object: 'refund', status }));
      await expect(statusOf(provider)('re_9')).resolves.toBe(outcome);
    }
    const last = http.calls.at(-1);
    expect(last?.method).toBe('GET');
    expect(last?.url).toBe('https://api.stripe.test/v1/refunds/re_9');
    expect(last?.headers?.['idempotency-key']).toBeUndefined();
  });

  it('refundStatus：鉴权头真的带上（替身无 Bearer 回 401）；非 2xx → 抛（查询失败 ≠ 退款失败）', async () => {
    const { http, provider } = build();
    http.failNext(404, '{"error":{"message":"No such refund"}}');
    await expect(statusOf(provider)('re_ghost')).rejects.toThrow(/查询退款失败：HTTP 404/);
    // 走替身本体（不 failNext）：替身按真 Stripe 规则验鉴权头，未登记的退款 → 404
    await expect(statusOf(provider)('re_unknown')).rejects.toThrow(/HTTP 404/);
    expect(http.calls.at(-1)?.headers?.['authorization']).toMatch(/^Bearer /);
  });
});

describe('expireSession（D-50 关单连带：会话立刻死，不等自然过期）', () => {
  /**
   * 与 refund 同模式：可选方法在接口上可以不实现，但 copylink 通道的会话就是
   * 短链跳转目标——订单关了会话还活着 = 已关单的链接还能跳去付款（钱货两开口）。
   */
  function mustExpire(p: PaymentProvider): NonNullable<PaymentProvider['expireSession']> {
    const fn = p.expireSession;
    if (fn === undefined) throw new Error('stripe（copylink）必须实现 expireSession()');
    return fn;
  }

  it('POST /v1/checkout/sessions/:id/expire，带授权与确定性幂等键 expire:{ref}', async () => {
    const { http, provider } = build();
    await mustExpire(provider)('cs_test_123');
    const call = http.calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://api.stripe.test/v1/checkout/sessions/cs_test_123/expire');
    expect(call?.headers?.['authorization']).toBe('Bearer sk_test_unit');
    // 幂等键含 providerRef：POST 超时后对同一会话的人工/重试落到同一键（出站红线同 refund）
    expect(call?.headers?.['idempotency-key']).toBe('expire:cs_test_123');
  });

  it('非 2xx → 抛错带会话号（调用方 best-effort 兜住，错误消息是它 warn 日志的素材）', async () => {
    const { http, provider } = build();
    http.failNext(400, '{"error":{"message":"already expired"}}');
    // ⚠️ 一次调用同时断言两点：failNext 只生效一次，调两次会让第二次真成功、断言变假
    const err = await mustExpire(provider)('cs_test_123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/作废失败/);
    expect((err as Error).message).toMatch(/cs_test_123/);
  });
});

describe('refund：生产里 providerRef 是 Checkout Session 号（KD-11，AJ-175）', () => {
  /**
   * @why 上面那组退款用例喂的是 `pi_1`——生产里 `payments.provider_ref` **从来不是** PI，
   *      而是 create() 登记的会话号 `cs_…`（约束三：假数据要像真的）。
   *      原实现把会话号原样当 `payment_intent` 传，真 Stripe 上每一笔退款都失败；
   *      这组用例用 create() 真返回的 providerRef 走一遍。
   */
  const refundOf = (p: PaymentProvider) => {
    const fn = p.refund;
    if (fn === undefined) throw new Error('stripe 必须实现 refund()');
    return fn;
  };
  const refundReq = (providerRef: string, reason = '缺货') => ({
    orderId: REQ.orderId,
    providerRef,
    amountJpy: 12_000,
    currency: 'JPY',
    amountMinor: 12_000,
    reason,
  });

  it('先 GET 会话取 payment_intent，再用 PI 退款（不是把 cs_ 当 PI）', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    expect(s.providerRef).toMatch(/^cs_/); // 前提：生产形态就是会话号
    const r = await refundOf(provider)(refundReq(s.providerRef));
    expect(r.outcome).toBe('succeeded');
    const [get, post] = http.calls.slice(-2);
    expect(get?.method).toBe('GET');
    expect(get?.url).toBe(`https://api.stripe.test/v1/checkout/sessions/${s.providerRef}`);
    expect(get?.headers?.['authorization']).toBe('Bearer sk_test_unit');
    expect(post?.url).toBe('https://api.stripe.test/v1/refunds');
    expect(formBody(post).get('payment_intent')).toBe(`pi_for_${s.providerRef}`);
    // 回带的 providerRef 仍是登记值（上层按它找 payments 行），不是换算后的 PI
    expect(r.providerRef).toBe(s.providerRef);
  });

  it('会话上 payment_intent 为空（未付款会话）→ 抛，且**不发**退款 POST', async () => {
    const { http, provider } = build();
    http.failNext(200, JSON.stringify({ id: 'cs_test_x', payment_intent: null }));
    await expect(refundOf(provider)(refundReq('cs_test_x'))).rejects.toThrow(/没有 payment_intent/);
    expect(http.calls.filter((c) => c.url.endsWith('/v1/refunds'))).toHaveLength(0);
  });

  it('会话反查失败（404/5xx）→ 抛带会话号，且不发退款 POST', async () => {
    const { http, provider } = build();
    const err = await refundOf(provider)(refundReq('cs_test_ghost')).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/反查会话失败：HTTP 404/);
    expect((err as Error).message).toMatch(/cs_test_ghost/);
    expect(http.calls.filter((c) => c.url.endsWith('/v1/refunds'))).toHaveLength(0);
  });

  it('payment_intent 被展开成对象时取其 id；未知单号族直接抛（不猜）', async () => {
    const { http, provider } = build();
    http.failNext(200, JSON.stringify({ id: 'cs_test_e', payment_intent: { id: 'pi_expanded' } }));
    await refundOf(provider)(refundReq('cs_test_e'));
    expect(formBody(http.calls.at(-1)).get('payment_intent')).toBe('pi_expanded');
    await expect(refundOf(provider)(refundReq('ch_123'))).rejects.toThrow(/无法识别的机构单号族/);
  });

  it('同一单重试退款：同键同参 → 回第一次那笔（不退两次）；同键换了原因 → 机构拒（KD-4 为什么要沿用原因）', async () => {
    const { provider } = build();
    const s = await provider.create(REQ);
    const first = await refundOf(provider)(refundReq(s.providerRef, '缺货'));
    const again = await refundOf(provider)(refundReq(s.providerRef, '缺货'));
    expect(again.refundRef).toBe(first.refundRef);
    await expect(refundOf(provider)(refundReq(s.providerRef, '客户改主意'))).rejects.toThrow(
      /idempotency_error/,
    );
  });
});

describe('create：收货信息附给 PaymentIntent（D-60①，一致性审计 C14 / AJ-176）', () => {
  const formOf = (http: ReturnType<typeof build>['http']) => formBody(http.calls.at(-1));

  it('完整地址 → payment_intent_data[shipping] 各字段；空串的可选字段不发', async () => {
    const { http, provider } = build();
    await provider.create({
      ...REQ,
      shipping: {
        name: 'Jane Doe',
        line1: '1 Infinite Loop',
        line2: '',
        city: 'Cupertino',
        state: 'CA',
        postalCode: '95014',
        country: 'US',
        phone: '+14155550123',
      },
    });
    const f = formOf(http);
    expect(f.get('payment_intent_data[shipping][name]')).toBe('Jane Doe');
    expect(f.get('payment_intent_data[shipping][address][line1]')).toBe('1 Infinite Loop');
    expect(f.has('payment_intent_data[shipping][address][line2]')).toBe(false);
    expect(f.get('payment_intent_data[shipping][address][postal_code]')).toBe('95014');
    expect(f.get('payment_intent_data[shipping][phone]')).toBe('+14155550123');
  });

  it('缺必填（name 或 line1）→ 整块不发，不编造半截地址；不传 shipping → 同样不发', async () => {
    for (const shipping of [
      { name: '', line1: '1 Infinite Loop' },
      { name: 'Jane Doe', line1: '' },
      undefined,
    ]) {
      const { http, provider } = build();
      await provider.create({ ...REQ, ...(shipping !== undefined ? { shipping } : {}) });
      const keys = [...formOf(http).keys()].filter((k) => k.includes('[shipping]'));
      expect(keys).toEqual([]);
    }
  });
});

describe('sessionStatus（取消前问机构，MP3-04）', () => {
  /**
   * @why 这张表是**整个防线的方向开关**：把 `unpaid` 误判成 processing 会让"没付款的人也取消不了"
   *      （日常可用性倒退），把 paid 误判成 unpaid 会让洞继续开着。所以三种取值各自钉一条。
   */
  it('payment_status → SessionStatus：paid / unpaid 直通，认不出的一律 processing', () => {
    expect(sessionOutcome('paid')).toBe('paid');
    expect(sessionOutcome('unpaid')).toBe('unpaid');
    // 认不出的三种真实形态：Stripe 的第三档、字段缺失、未来新增枚举
    expect(sessionOutcome('no_payment_required')).toBe('processing');
    expect(sessionOutcome(undefined)).toBe('processing');
    expect(sessionOutcome('paid_or_unpaid?')).toBe('processing');
  });

  it('🔴 机构说已付 → paid（这正是"付了钱、通知还没到"那一刻要读到的值）', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    http.setSessionPaymentStatus(s.providerRef, 'paid');
    await expect(provider.sessionStatus?.(s.providerRef)).resolves.toBe('paid');
  });

  it('刚建的会话（未付）→ unpaid：日常取消必须还能取消', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    http.setSessionPaymentStatus(s.providerRef, 'unpaid');
    await expect(provider.sessionStatus?.(s.providerRef)).resolves.toBe('unpaid');
  });

  it('走 GET /v1/checkout/sessions/{id}，不带幂等键（幂等只对 POST 有意义）', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    http.calls.length = 0;
    await provider.sessionStatus?.(s.providerRef);
    const call = http.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(`https://api.stripe.test/v1/checkout/sessions/${s.providerRef}`);
    expect(call?.headers?.['idempotency-key']).toBeUndefined();
    expect(call?.headers?.['authorization']).toBe('Bearer sk_test_unit');
  });

  it('🔴 查不到（5xx）→ 抛错，由调用方按 fail-closed 处理（不静默当成"没付"）', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    http.failNext(502);
    await expect(provider.sessionStatus?.(s.providerRef)).rejects.toThrow(/502/);
  });
});

describe('出网 API 版本覆盖全部调用点（PAY3-03 的下半：漏一个点就等于没钉）', () => {
  /**
   * @why 单独一组而不是只在 create 上断言一次：本适配器是裸 REST，7 个出网调用点
   *      **各自**都要带 `Stripe-Version`，而最容易漏的恰恰是最少被调用的那几个
   *      （退款前反查会话 / 作废会话 / 拒付反查 PaymentIntent）——漏了不会红、不会报警，
   *      只会在某天 Stripe 改账户默认版本时，让"建会话"和"读会话"看到两套不同的语义。
   * @why 用**遍历所有调用**而不是逐条 `expect(calls[i])`：
   *      逐条断言在新增第 8 个调用点时不会红（新点漏了头照样全绿），
   *      遍历则会——这正是"防复发"（约束九）要的形状。
   */
  it('create / sessionStatus / expireSession / refund(含反查) 的每一次出网都带同一版本', async () => {
    const { http, provider } = build();
    const s = await provider.create(REQ);
    await provider.sessionStatus?.(s.providerRef);
    await provider.expireSession?.(s.providerRef);
    await provider.refund?.({
      orderId: REQ.orderId,
      providerRef: s.providerRef, // cs_…：走"先 GET 会话取 PI，再 POST 退款"两条请求
      amountJpy: 12_000,
      currency: 'JPY',
      amountMinor: 12_000,
      reason: '缺货',
    });

    expect(http.calls.length).toBeGreaterThanOrEqual(5);
    for (const c of http.calls) {
      // 消息里带 url：将来真漏了能一眼看出是哪个调用点，不用去数下标
      expect(c.headers?.[STRIPE_VERSION_HEADER], `url=${c.url}`).toBe(STRIPE_API_VERSION);
    }
  });

  it('拒付反查 PaymentIntent 那条 GET 也带版本（它只在拒付当天才跑）', async () => {
    /**
     * @why 这条路径**只有真实拒付才会走**（dispute 对象上没有 metadata → 反查 PI 取 order_id）。
     *      它一辈子跑不了几次，因此不会有任何"跑得多所以暴露得早"的机会——
     *      能守住它的只有一条明确写下的用例。
     */
    const { http, provider } = build();
    // B5 / AJ-198：替身里的 PI 必须带本系统标记，否则会被当成"账户里非本系统的付款"
    http.givenPaymentIntent('pi_dp_1', { order_id: REQ.orderId, source: STRIPE_SOURCE_TAG });
    const body = JSON.stringify(
      stripeEvent('charge.dispute.created', { ...dispute({ paymentIntent: 'pi_dp_1' }) }),
    );
    const ev = await provider.parseWebhook(Buffer.from(body, 'utf8'), {
      [HEADER]: signStripePayload(body, SECRET, NOW_SEC),
    } as HeaderBag);
    expect(ev.orderId).toBe(REQ.orderId); // 前提：确实走了反查通道（否则下面断言的是空集）
    const calls = http.calls.filter((c) => c.url.includes('/v1/payment_intents/'));
    expect(calls.length).toBe(1);
    for (const c of calls) expect(c.headers?.[STRIPE_VERSION_HEADER]).toBe(STRIPE_API_VERSION);
  });
});

/**
 * `charge.refunded` 的**金额口径**（AJ-376）。
 *
 * @why 这一组不是"正确行为"的守卫，而是**债务登记**：`refunded` 这个 outcome 目前
 *      没有 applier（`refund-execution.ts` 的 @tradeoff 明写不接机构的退款回调），
 *      所以取错金额**今天无人报错**。等到 F12 售后落账时，谁写 applier 谁就会读到
 *      `event.amountMinor`——而它现在是**原扣款全额**，不是退款额。
 *      把它们钉成断言，F12 改口径时这组会红，逼人确认而不是静默生效。
 *
 * @why 三个字段各说一件事，必须分开钉：`amount`（原扣款）/ `amount_refunded`（**累计**已退）
 *      / `refunded` 布尔（**仅**全额退完才 true）。原注释只写了"取 amount_refunded"，
 *      而它是**累计值**——第二次部分退款时它等于两次之和，拿它当"本次退了多少"会多退。
 *
 * @measured 真实事件样例与字段语义见 `stripe-checkout.ts` 的 OUTCOME_BY_TYPE['charge.refunded']
 *      （五处独立来源一致）；本组的样本形状照抄那份样例，不是凭印象造。
 */
describe('charge.refunded 的金额口径（AJ-376：债务登记，F12 改口径时这一组会红）', () => {
  /** 照抄实测样例的形状：一笔 10000 的扣款，第一次退 3000（部分退款）。 */
  function chargeRefunded(over: Partial<Record<string, unknown>> = {}) {
    return {
      object: 'charge',
      id: 'ch_x',
      amount: 10_000, // 原扣款全额
      amount_captured: 10_000,
      amount_refunded: 3_000, // 累计已退 3000
      refunded: false, // ⚠️ 部分退款时**仍是 false**
      currency: 'jpy',
      payment_intent: 'pi_x',
      created: 1_694_109_201,
      refunds: {
        object: 'list',
        data: [
          {
            object: 'refund',
            id: 're_x',
            amount: 3_000, // 本次退的
            currency: 'jpy',
            status: 'succeeded',
            created: 1_694_109_201,
          },
        ],
      },
      ...over,
    };
  }

  async function parse(object: Record<string, unknown>) {
    const { provider } = build();
    const { raw, headers } = signed('charge.refunded', { object });
    return provider.parseWebhook(raw, headers);
  }

  it('当前口径（债务，F12）：amountMinor 取的是**原扣款全额**（10000），不是退款额（3000）', async () => {
    const ev = await parse(chargeRefunded());
    expect(ev.outcome).toBe('refunded'); // 前提：确实归一化成了 refunded（否则下面断言的是空集）
    expect(ev.amountMinor).toBe(10_000);
  });

  /**
   * 债务钉子（审查 2026-10-09 C2）：用 `it.fails` 钉住"正确取法"——现在实现取全额 ⇒ 断言失败 ⇒ 用例通过；
   * F12 把 amountMinor 改成本次退款额那天，这条会红，提醒把它改回普通 `it` 并删掉上面那条"当前口径"。
   */
  it.fails(
    '[债务 F12] amountMinor 应取本次退款额 3000（refunds.data[0].amount）——修好后此 it.fails 会红',
    async () => {
      const ev = await parse(chargeRefunded());
      expect(ev.amountMinor).toBe(3_000);
    },
  );

  it('全额退款时两者相等——所以"取错了"只在**部分退款**时才暴露（最不容易被测到的那种）', async () => {
    const ev = await parse(chargeRefunded({ amount_refunded: 10_000, refunded: true }));
    // 全额退款：全额 == 累计已退，取哪个都对 ⇒ 只测全额的用例**永远绿**，测不出这个洞
    expect(ev.amountMinor).toBe(10_000);
  });

  it('当前口径（债务，F12）第二次部分退款：amount_refunded 是**累计**（6000），而 amountMinor 仍是全额 10000', async () => {
    const ev = await parse(
      chargeRefunded({
        amount_refunded: 6_000, // 累计：3000 + 3000
        refunds: {
          object: 'list',
          data: [
            { object: 'refund', id: 're_1', amount: 3_000, status: 'succeeded' },
            { object: 'refund', id: 're_2', amount: 3_000, status: 'succeeded' },
          ],
        },
      }),
    );
    expect(ev.amountMinor).toBe(10_000);
  });

  /**
   * @why 钉住"正确取法"在载荷里**确实存在**——否则 F12 的人会以为只能凑合用 `amount`。
   *      本次退款额在 `refunds.data[]` 各自那条上，累计在 `amount_refunded`，
   *      是否全额退完在 `refunded` 布尔。**三个都要，缺一个就会在某个场景记错账。**
   */
  it('夹具形状自检（不验实现）：载荷里三个口径都在（给 F12 留的取法：本次在 refunds.data[]，累计在 amount_refunded）', () => {
    // 审查 2026-10-09 C1：这条只钉**夹具**长得像真 Stripe 载荷，被测代码一行不跑——别把它当成实现的覆盖
    const obj = chargeRefunded();
    // 直接验样本形状：这三个键与本组第一条断言用的同一份对象
    expect(obj.amount).toBe(10_000);
    expect(obj.amount_refunded).toBe(3_000);
    expect(obj.refunded).toBe(false);
    expect((obj.refunds.data[0] as { amount: number }).amount).toBe(3_000);
  });

  it('部分退款的 refunded 布尔是 false——拿它当"已退款"判据会漏掉所有部分退款', async () => {
    const ev = await parse(chargeRefunded());
    // `refunded` 布尔不进 ProviderEvent（端口没这个字段），这里只钉住"它不参与判定"：
    // outcome 由**事件类型**决定，与退了多少无关
    expect(ev.outcome).toBe('refunded');
    expect(ev.amountMinor).toBe(10_000);
  });
});
