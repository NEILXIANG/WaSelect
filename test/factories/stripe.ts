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
 * @limitation 二：造 `checkout.session.*` / `payment_intent.*` / `charge.refunded` /
 *              `charge.dispute.created` 四类。其余（refund.updated、dispute.closed 等售后后续事件）
 *              在用到时按同一方式补，不预先编（豁免名单见 STRIPE_EVENTS_NOT_SAMPLED）。
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

/** Checkout Session 的字段子集。 */
export interface CheckoutSessionSeed {
  id?: string;
  /** `paid` / `unpaid` / `no_payment_required` */
  paymentStatus?: string;
  /** `complete` / `expired` / `open` */
  status?: string;
  amountTotal?: number;
  currency?: string;
  paymentIntent?: string | null;
  metadata?: Record<string, string>;
}

/**
 * 覆盖项。**语义刻意收窄**：只能改顶层字段与 `dataObject`，且 `dataObject` 是**深合并**。
 * @why 上一版直接把 `Partial<StripeEvent>` 铺在最后（`...overrides`），于是传
 *      `{ data: { object: { id } } }` 会把合并好的 `data.object` **整体替换**掉，
 *      造出一条只有 id 的残缺回调——而用它测出来的解析代码会在真环境里取不到任何字段。
 *      覆盖语义含糊（"这是替换还是合并？"）本身就是缺陷来源，所以从 API 上消除它。
 */
export interface StripeEventOverrides {
  id?: string;
  created?: number;
  livemode?: boolean;
  /** 深合并进 `data.object`，不会替换掉默认字段。 */
  dataObject?: Record<string, unknown>;
}

/** `data.object` = PaymentIntent 的形状（含我们会读的字段）。 */
export function paymentIntent(seed: PaymentIntentSeed = {}): Record<string, unknown> {
  return {
    id: seed.id ?? 'pi_3P0000000000000000000000',
    object: 'payment_intent',
    amount: seed.amount ?? 12_000,
    currency: seed.currency ?? 'jpy',
    status: seed.status ?? 'succeeded',
    metadata: seed.metadata ?? {},
    // 下面两个是"我们会用到但容易漏"的字段
    capture_method: 'automatic',
    last_payment_error: null,
  };
}

/**
 * `data.object` = Checkout Session 的形状。
 * @why D-49（2026-09-22）把银行卡入口改成 **Stripe Checkout 托管页**，
 *      所以主事件是 `checkout.session.*` 而不是 `payment_intent.*`。
 *      （更早的 D-31 定的是自建 H5 + Payment Element，已被 D-49 推翻；
 *        `docs/开发前审计报告-2026-09-19.md` 第 15 条据此要求"改用 payment_intent"，
 *        现在属**反向错误指引**，不要照它改。）
 */
export function checkoutSession(seed: CheckoutSessionSeed = {}): Record<string, unknown> {
  return {
    id: seed.id ?? 'cs_test_a1B2c3D4e5F6g7H8',
    object: 'checkout.session',
    status: seed.status ?? 'complete',
    payment_status: seed.paymentStatus ?? 'paid',
    amount_total: seed.amountTotal ?? 12_000,
    currency: seed.currency ?? 'jpy',
    payment_intent: seed.paymentIntent ?? 'pi_3P0000000000000000000000',
    metadata: seed.metadata ?? {},
  };
}

/**
 * `data.object` = Charge 的形状（`charge.refunded` 用）。
 *
 * @why metadata 默认带 order_id：官方口径是"建 Charge 时 PaymentIntent 的 metadata
 *      会复制到 Charge"，而我们的 create 会写 `payment_intent_data.metadata.order_id`——
 *      所以**真实**的 charge 事件一定带着它。样本若不照这个形状造，
 *      解析代码就可能在"metadata 恒存在"的假设上写死，而测不出来。
 */
export function charge(seed: { metadata?: Record<string, string> } = {}): Record<string, unknown> {
  return {
    id: 'ch_3P0000000000000000000000',
    object: 'charge',
    amount: 12_000,
    currency: 'jpy',
    payment_intent: 'pi_3P0000000000000000000000',
    refunded: true,
    amount_refunded: 12_000,
    metadata: seed.metadata ?? { order_id: 'sk-sample-order' },
  };
}

/**
 * `data.object` = Dispute 的形状（`charge.dispute.*` 用）。
 *
 * ⚠️ **刻意不带 metadata、不带 client_reference_id**：Stripe 不会把 metadata 复制到
 *    Dispute 上，链回订单的唯一字段是 `payment_intent`（适配器据此反查）。
 *    曾经把它造成 `{object: 'charge'}`——形状错了，于是"dispute 取不到 order_id"
 *    这个真实失效形态在测试里根本不存在（体检 P1-7 的掩盖层之一）。
 */
export function dispute(seed: { paymentIntent?: string } = {}): Record<string, unknown> {
  return {
    id: 'du_3P0000000000000000000000',
    object: 'dispute',
    amount: 12_000,
    currency: 'jpy',
    charge: 'ch_3P0000000000000000000000',
    payment_intent: seed.paymentIntent ?? 'pi_3P0000000000000000000000',
    reason: 'fraudulent',
    status: 'warning_needs_response',
  };
}

/**
 * 造一个 Stripe 事件（形状与官方一致）。
 * @param type 事件类型
 * @param object 该事件的 `data.object` 内容（用 `paymentIntent()` / `checkoutSession()` / `charge()` / `dispute()` 造）
 * @param overrides 覆盖项，见 `StripeEventOverrides`（`dataObject` 为深合并）
 */
export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  overrides: StripeEventOverrides = {},
): StripeEvent {
  const created = overrides.created ?? 1_700_000_000;
  return {
    id: overrides.id ?? 'evt_00000000000000',
    object: 'event',
    api_version: '2024-06-20',
    created,
    livemode: overrides.livemode ?? false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: { ...object, ...(overrides.dataObject ?? {}) } },
  };
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

/**
 * 我们会处理的事件类型。
 * @why **逐条抄自 `contracts/api-contract.yaml` 的 `/pay/callback/stripe`**，
 *      那里标注了 `（D-49/D-50）`。判定口径不必查外部资料——本仓库的契约自己写着，
 *      而且 `stripe.contract.test.ts` 会反过来要求：契约里列出的事件，样本工厂必须都造得出来。
 * @limitation `charge.refund.updated` / `refund.failed` 与 `charge.dispute.closed` 等
 *      在契约里列了但尚未造样本（当前业务用不到）；契约测试里走豁免名单并写明原因，
 *      用到时必须补，不能永久豁免。
 */
export const STRIPE_EVENT_TYPES = {
  // ── 主路径：Checkout 托管页（D-49）──
  checkoutCompleted: 'checkout.session.completed',
  checkoutExpired: 'checkout.session.expired',
  checkoutAsyncSucceeded: 'checkout.session.async_payment_succeeded',
  checkoutAsyncFailed: 'checkout.session.async_payment_failed',
  // ── 次路径：PaymentIntent（托管页背后的对象，也要能处理）──
  paySucceeded: 'payment_intent.succeeded',
  payFailed: 'payment_intent.payment_failed',
  payCanceled: 'payment_intent.canceled',
  // ── 售后 ──
  refundSucceeded: 'charge.refunded',
  disputeCreated: 'charge.dispute.created',
} as const;

/** 尚未造样本、但契约已列出的事件（用到时必须补，不能永久豁免）。 */
export const STRIPE_EVENTS_NOT_SAMPLED: readonly string[] = [
  'refund.updated',
  'refund.failed',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
];

/** 每个事件对应的 `data.object` 形状工厂：造样本时不必自己判断该用哪个。 */
export function objectForEvent(type: string): Record<string, unknown> {
  if (type.startsWith('checkout.session.')) return checkoutSession();
  if (type.startsWith('payment_intent.')) return paymentIntent();
  if (type.startsWith('charge.dispute.')) return dispute();
  if (type.startsWith('charge.')) return charge();
  throw new Error(`未知事件类型，未定义样本形状：${type}`);
}
