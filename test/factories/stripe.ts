/**
 * 职责：Stripe 回调样本（F9-d1）——形状与签名都照官方口径造，不靠记忆。
 *
 * @why 支付回调是"钱到了"的唯一凭据，样本形状写错会带来一种最坏的假绿灯：
 *      我们按自己编的形状写的解析代码，在真环境里**一个字段都取不到**，
 *      而所有测试都是绿的。所以形状必须来自官方文档，并把来源写进注释。
 *
 * 官方口径（已核对，2026-09-23）：
 *  - 签名头：`Stripe-Signature: t=<unix 秒>,v1=<hex>`，v1 可能有多个（密钥轮换），
 *    测试模式还会多带一个 `v0`（**必须忽略**，v0 不是有效签名）。
 *  - 被签串：`${t}.${原始报文}`——**是原始字节**，JSON 重新序列化会改变字节导致验不过。
 *  - 算法：HMAC-SHA256，密钥是 endpoint 的 `whsec_...`（不是 API key），输出 hex。
 *  - 容差：官方库默认 300 秒；验过签名但时间戳过旧仍应拒（防重放）。
 *
 * @limitation 一：这里的 `verifyStripeSignature` 是**测试用的交叉验证实现**，
 *              不是生产实现。F11 会用官方 SDK 的 `stripe.webhooks.constructEvent`；
 *              保留一份独立实现是为了能用"另一套算法"验我造的样本，避免自证。
 * @limitation 二：只造 `payment_intent.*` 与 `charge.*` 两类事件。
 *              其余事件（退款、争议）的形状在用到时按同一方式补，不预先编。
 * @limitation 三：金额一律用**最小货币单位整数**（JPY 是零小数币种，1 円 = 1）。
 *              Stripe 对 JPY 不做 /100 处理，写成 amount=100 就是 100 円——
 *              与 USD（分）混用是跨境支付最常见的金额事故，这里刻意只造 JPY。
 *
 * @see https://docs.stripe.com/webhooks（事件结构与最佳实践）
 * @see https://docs.stripe.com/webhooks/signatures（签名与验签步骤）
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** 官方库默认容差：5 分钟。 */
export const STRIPE_DEFAULT_TOLERANCE_SEC = 300;

export interface StripeEvent {
  id: string;
  object: 'event';
  api_version: string;
  created: number;
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: string;
  data: { object: Record<string, unknown> };
}

/** PaymentIntent 的字段子集：只放我们真会读的字段（多了就是猜）。 */
export interface PaymentIntentSeed {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  metadata?: Record<string, string>;
}

/**
 * 造一个 Stripe 事件（形状与官方一致，字段可覆盖）。
 * @param type 事件类型，如 `payment_intent.succeeded`
 * @param pi   `data.object` 的内容
 */
export function stripeEvent(
  type: string,
  pi: PaymentIntentSeed = {},
  overrides: Partial<StripeEvent> = {},
): StripeEvent {
  const created = overrides.created ?? 1_700_000_000;
  const intent: Record<string, unknown> = {
    id: pi.id ?? 'pi_3P0000000000000000000000',
    object: 'payment_intent',
    amount: pi.amount ?? 12_000,
    currency: pi.currency ?? 'jpy',
    status: pi.status ?? 'succeeded',
    metadata: pi.metadata ?? {},
    // 下面三个是"我们会用到但容易漏"的字段：捕获方式、最新错误、创建时间
    capture_method: 'automatic',
    last_payment_error: null,
    created,
  };
  const base: StripeEvent = {
    id: 'evt_00000000000000',
    object: 'event',
    api_version: '2024-06-20',
    created,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: intent },
  };
  return { ...base, data: { object: { ...intent, ...(overrides.data?.object ?? {}) } }, ...overrides };
}

/**
 * 按官方口径生成 `Stripe-Signature` 头的值。
 * @param body **原始报文字符串**（必须是未被重新序列化的字节对应的文本）
 * @param secret endpoint 密钥（`whsec_...`）
 * @param t unix 秒；不传用当前时间。**造"迟到回调"样本时传一个过去的时间。**
 */
export function signStripePayload(body: string, secret: string, t?: number): string {
  const timestamp = t ?? Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/**
 * 测试用的独立验签实现（**不是生产实现**，见 @limitation 一）。
 * @returns 通过 / 失败原因（区分"签名不对"与"时间戳过旧"，这两类排障方向完全不同）
 */
export function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): { ok: true } | { ok: false; reason: 'no_header' | 'no_v1' | 'bad_signature' | 'expired' } {
  if (header === undefined) return { ok: false, reason: 'no_header' };
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (t === undefined || v1s.length === 0) return { ok: false, reason: 'no_v1' };

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'),
    'utf8',
  );
  // 多个 v1（密钥轮换）时任一命中即通过
  const matched = v1s.some((v) => {
    const got = Buffer.from(v, 'utf8');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!matched) return { ok: false, reason: 'bad_signature' };

  const tolerance = opts.toleranceSec ?? STRIPE_DEFAULT_TOLERANCE_SEC;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > tolerance) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** 常用事件类型（只列我们真会处理的；其余按官方清单补）。 */
export const STRIPE_EVENT_TYPES = {
  paySucceeded: 'payment_intent.succeeded',
  payFailed: 'payment_intent.payment_failed',
  refundSucceeded: 'charge.refunded',
  disputeCreated: 'charge.dispute.created',
} as const;
