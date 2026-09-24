/**
 * 职责：**Stripe Checkout 托管页**通道（F11 的第二个真实实现，D-49）。
 *
 * @why 它是"抽象是否成立"的**检验者**：Mock 是第一个实现，而第一个实现总是
 *      照着接口写、也总会"恰好"适合接口——因为接口就是照着它提炼的。
 *      只有第二个实现接进来还不用改接口，抽象才算成立。
 *      所以本文件刻意**不复用** mock 的任何报文/签名约定，完全按 Stripe 官方口径写，
 *      两边越独立，检验越有力。
 *
 * 业务口径（D-49，以本仓库 `contracts/api-contract.yaml` 为准，不要查旧审计文档）：
 *  - 银行卡入口 = **复制链接 → Stripe Checkout 托管页**（小程序内不做卡表单）；
 *  - 主事件 = `checkout.session.completed / expired`，次路径 `payment_intent.*`；
 *  - 退款/拒付 = `charge.refunded` / `charge.dispute.created`。
 *
 * @limitation 一：**JPY 是零小数币种**，`unit_amount` 直接写円（12,000 = 12,000 円）。
 *              USD 要写"分"（$12.00 = 1200）。两者混用是跨境支付最常见的金额事故，
 *              所以这里只在 `currencies` 里声明 JPY/USD 且**按币种分别换算**（见 `toMinorUnits`）。
 * @limitation 二：**不重试**（端口 @limitation 一）。Stripe 侧靠 `Idempotency-Key` 保证
 *              重复请求不重复建单；我们自己的重试策略属 F12。
 * @limitation 三：4xx/5xx 一律抛普通 Error（被上层折叠成 50000）。
 *              "卡被拒（402）"这类**需要给用户看**的细分错误，要等业务期拿到真实错误码表再映射，
 *              现在猜一个映射表比不映射更危险（猜错会把"用户余额不足"说成"系统故障"）。
 * @limitation 四：webhook 验签的容差取**应用时钟**（注入的 `Clock`）。
 *              严格说"防重放"应以上游时间为准，但两端时钟差超过 300 秒本就是故障；
 *              用注入时钟换来的是"过期判定可测"（否则要真的等 5 分钟）。
 *
 * @see ../../ports/payment.ts；test/factories/stripe.ts（样本与**独立的**交叉验签实现）；
 *      https://docs.stripe.com/webhooks/signatures
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGen } from '../../ports/ids.js';
import type { HttpClient } from '../../ports/http-client.js';
import type {
  ChannelConfig,
  HeaderBag,
  PaymentProvider,
  PaymentRequest,
  PaymentSession,
  ProviderEvent,
  RefundRequest,
} from '../../ports/payment.js';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** 官方库默认容差 5 分钟；超过这个时间的报文即使签名正确也拒（防重放）。 */
export const STRIPE_TOLERANCE_SEC = 300;

/** 事件类型 → 归一化结果。**未列出的一律 unknown**（不猜）。 */
const OUTCOME_BY_TYPE: Readonly<Record<string, ProviderEvent['outcome']>> = {
  'checkout.session.completed': 'succeeded',
  'checkout.session.async_payment_succeeded': 'succeeded',
  'checkout.session.async_payment_failed': 'failed',
  'checkout.session.expired': 'expired',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'expired',
  'charge.refunded': 'refunded',
  'charge.dispute.created': 'disputed',
};

/** 零小数币种（最小单位 = 主单位）。JPY 是典型；写错会把 100 円收成 1 円。 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP']);

/**
 * 主单位 → 机构最小单位。
 * @why 抽成函数是因为"×100"这类换算一旦散落，加币种时就会漏一处，
 *      而漏掉的表现是**金额差 100 倍**——可能是少收，也可能是多收。
 */
export function toMinorUnits(amountMajor: number, currency: string): number {
  const upper = currency.toUpperCase();
  return ZERO_DECIMAL.has(upper) ? Math.round(amountMajor) : Math.round(amountMajor * 100);
}

interface StripeOptions {
  /** `sk_test_...` / `sk_live_...`（**绝不能进日志**）。 */
  secretKey: string;
  /** endpoint 密钥 `whsec_...`（**不是** API key，两者混淆是最常见的验签失败原因）。 */
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  /** API 基址（测试注入假环境用；缺省官方地址）。 */
  apiBase?: string;
}

function optionsOf(cfg: ChannelConfig): StripeOptions {
  const o = cfg.options ?? {};
  const need = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `stripe 通道缺少 options.${k}（channel=${cfg.channel}）：装配期就要炸，不能等第一次调用`,
      );
    }
    return v;
  };
  return {
    secretKey: need('secretKey'),
    webhookSecret: need('webhookSecret'),
    successUrl: need('successUrl'),
    cancelUrl: need('cancelUrl'),
    ...(typeof o['apiBase'] === 'string' ? { apiBase: o['apiBase'] } : {}),
  };
}

export interface StripeProviderDeps {
  http: HttpClient;
  clock: Clock;
  idGen: IdGen;
}

export function createStripeCheckoutProvider(
  cfg: ChannelConfig,
  deps: StripeProviderDeps,
): PaymentProvider {
  const opts = optionsOf(cfg);
  const apiBase = opts.apiBase ?? 'https://api.stripe.com';

  /**
   * 验签（官方口径）：`HMAC-SHA256(secret, `${t}.${raw}`)` 与 `v1` 比较。
   *
   * @why 自己实现而不引官方 SDK：MVP 只需要"建会话 + 验签 + 退款"三件事，
   *      引 SDK 会带进一整套对象模型与版本耦合；
   *      而验签算法是**公开且稳定**的（官方文档写死），照着实现没有歧义。
   *      风险由 `test/factories/stripe.ts` 里那份**独立实现**交叉验证来兜（避免自证）。
   */
  function verify(raw: Buffer, header: string | undefined): void {
    if (header === undefined || header.length === 0) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_no_signature' });
    }
    const parts = header.split(',').map((p) => p.trim());
    const t = parts.find((p) => p.startsWith('t='))?.slice(2);
    // ⚠️ 只认 v1：`v0` 是测试模式的干扰项，**必须忽略**（把它当签名会永远验不过）
    const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (t === undefined || v1s.length === 0) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_signature_malformed' });
    }
    const expected = Buffer.from(
      createHmac('sha256', opts.webhookSecret)
        .update(`${t}.${raw.toString('utf8')}`)
        .digest('hex'),
      'utf8',
    );
    // 多个 v1（密钥轮换期）任一命中即通过
    const matched = v1s.some((v) => {
      const got = Buffer.from(v, 'utf8');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    if (!matched) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_signature_mismatch' });
    }
    // 时间容差：签名对但时间戳过旧 → 仍是 40103（防重放，不重试）
    const nowSec = Math.floor(deps.clock.now().getTime() / 1000);
    if (Math.abs(nowSec - Number(t)) > STRIPE_TOLERANCE_SEC) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_timestamp_expired' });
    }
  }

  /** 取订单 id：metadata.order_id（我们 create 时写进去的）→ client_reference_id。 */
  function orderIdOf(obj: Record<string, unknown>): string {
    const md = obj['metadata'] as Record<string, unknown> | undefined;
    const fromMeta = md?.['order_id'];
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
    const ref = obj['client_reference_id'];
    if (typeof ref === 'string' && ref.length > 0) return ref;
    // 取不到 = 我们在 create 时没把单号写进 metadata，是**自己的**缺陷，不是入站方的问题
    throw new Error(
      `stripe 回调里取不到 order_id（type=${String(obj['object'])}）：create 时未写入 metadata.order_id`,
    );
  }

  return {
    channel: cfg.channel,
    capabilities: {
      currencies: ['JPY', 'USD'],
      countries: ['*'],
      entryMode: 'copylink',
      supportsRefund: true,
      supportsPartialRefund: false,
      supportsDispute: true,
      refundableWhenDisabled: true,
    },

    async create(req: PaymentRequest): Promise<PaymentSession> {
      const form = new URLSearchParams({
        mode: 'payment',
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        client_reference_id: req.orderId,
        'metadata[order_id]': req.orderId,
        'metadata[order_no]': req.orderNo,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': req.currency.toLowerCase(),
        // ⚠️ 只做"主单位 → 最小单位"（JPY 不 ×100，USD ×100）；
        //    **JPY → 别的币种**的换算是 domain 的事，端口不碰（见 PaymentRequest.amountInCurrency）
        'line_items[0][price_data][unit_amount]': String(
          toMinorUnits(req.amountInCurrency, req.currency),
        ),
        'line_items[0][price_data][product_data][name]': `WaSelect 订单 ${req.orderNo}`,
      });
      const res = await deps.http.send({
        method: 'POST',
        url: `${apiBase}/v1/checkout/sessions`,
        headers: {
          authorization: `Bearer ${opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // 机构侧幂等：同一键重试不会建第二个会话（我们自己的幂等表是另一层）
          'idempotency-key': req.idempotencyKey,
        },
        body: form.toString(),
      });
      if (res.status < 200 || res.status >= 300) {
        // @security 只带状态与前 200 字符：上游错误体可能含 PII，且只进日志
        throw new Error(
          `stripe 建会话失败：HTTP ${res.status} ${res.body.slice(0, 200)}（order=${req.orderId}）`,
        );
      }
      const json = JSON.parse(res.body) as { id?: string; url?: string; expires_at?: number };
      if (typeof json.id !== 'string' || typeof json.url !== 'string') {
        throw new Error(`stripe 建会话响应缺 id/url（order=${req.orderId}）`);
      }
      return {
        providerRef: json.id,
        entry: { mode: 'copylink', url: json.url },
        ...(typeof json.expires_at === 'number'
          ? { expiresAt: new Date(json.expires_at * 1000).toISOString() }
          : {}),
      };
    },

    async parseWebhook(raw: Buffer, headers: HeaderBag): Promise<ProviderEvent> {
      verify(raw, headers[STRIPE_SIGNATURE_HEADER]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(40001, { channel: cfg.channel, reason: 'stripe_payload_not_json' });
      }
      const ev = parsed as {
        id?: string;
        type?: string;
        data?: { object?: Record<string, unknown> };
      };
      const obj = ev.data?.object ?? {};
      const type = typeof ev.type === 'string' ? ev.type : 'unknown';
      const amount =
        typeof obj['amount_total'] === 'number'
          ? obj['amount_total']
          : typeof obj['amount'] === 'number'
            ? obj['amount']
            : undefined;
      const currency =
        typeof obj['currency'] === 'string' ? obj['currency'].toUpperCase() : undefined;
      return {
        eventId: typeof ev.id === 'string' ? ev.id : `gen-${deps.idGen.uuid()}`,
        rawType: type,
        outcome: OUTCOME_BY_TYPE[type] ?? 'unknown',
        orderId: orderIdOf(obj),
        providerRef:
          typeof obj['id'] === 'string'
            ? obj['id']
            : typeof obj['payment_intent'] === 'string'
              ? obj['payment_intent']
              : '',
        // ⚠️ 原样回带**最小单位 + 币种**，不换算成 JPY（换算属 domain，用订单的 fx_snapshot）
        ...(amount !== undefined ? { amountMinor: amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
      };
    },

    async refund(req: RefundRequest) {
      const form = new URLSearchParams({
        payment_intent: req.providerRef,
        // 原币退（见 RefundRequest.currency 的 @why）：币种与金额都来自**扣款当时**的那笔
        amount: String(toMinorUnits(req.amountInCurrency, req.currency)),
        'metadata[order_id]': req.orderId,
        'metadata[reason]': req.reason,
      });
      const res = await deps.http.send({
        method: 'POST',
        url: `${apiBase}/v1/refunds`,
        headers: {
          authorization: `Bearer ${opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `stripe 退款失败：HTTP ${res.status} ${res.body.slice(0, 200)}（order=${req.orderId}）`,
        );
      }
      const json = JSON.parse(res.body) as { id?: string; status?: string };
      if (typeof json.id !== 'string') {
        throw new Error(`stripe 退款响应缺 id（order=${req.orderId}）`);
      }
      return {
        providerRef: req.providerRef,
        refundRef: json.id,
        outcome:
          json.status === 'succeeded'
            ? 'succeeded'
            : json.status === 'pending'
              ? 'pending'
              : 'failed',
      };
    },
  };
}
