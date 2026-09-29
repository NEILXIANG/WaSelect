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
 * @limitation 一：金额进本适配器时**已经是整数最小单位**（端口口径，JPY=円、USD=分），
 *              这里只做 `String()` 透传。"JPY 零小数不 ×100、USD ×100"的知识唯一存在于
 *              `packages/shared/money.ts`（二次审查 P3-1：适配器曾经自己换算，是全仓
 *              第二处金额取整，`.5` 边界会与 domain 差 1 分）。
 * @limitation 二：**不重试**（端口 @limitation 一）。Stripe 侧靠 `Idempotency-Key` 保证
 *              重复请求不重复建单/退款；我们自己的重试策略属 F12。
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
import { clipRefundReason } from '../../domain/admin-order-actions.js';
import type {
  ChannelConfig,
  HeaderBag,
  PaymentProvider,
  PaymentRequest,
  PaymentSession,
  ProviderEvent,
  RefundRequest,
  RefundResult,
} from '../../ports/payment.js';
// 值导入（不是 type）：B3 / AJ-199 —— 适配器要**抛**这个契约错误，业务层按类型分辨"是否换幂等键"
import { ProviderRejectedError } from '../../ports/payment.js';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** 官方库默认容差 5 分钟；超过这个时间的报文即使签名正确也拒（防重放）。 */
export const STRIPE_TOLERANCE_SEC = 300;

/**
 * **本系统标记**：`create()` 时连同 `order_id` 一起写进 Session 与 PaymentIntent 的 metadata（B5 / AJ-198）。
 *
 * @why 同一个 Stripe 账户里**不一定只有本系统的付款**：运营用 Payment Link / Dashboard /
 *      Invoice 收的款，其 `checkout.session.completed` 与 `payment_intent.succeeded`
 *      也会打到同一个回调端点（端点订阅哪些事件由控制台决定），而它们**没有** `metadata.order_id`。
 *      旧实现对这类事件一律抛错 → 500；Stripe 会按退避重发约 3 天，
 *      **持续失败的端点会被停用**——届时真实订单的回调也一起收不到（钱收了、订单永远 pending_payment）。
 * @why 为什么需要"有没有我们的标记"这一层，而不是继续按"取不到单号就 unknown"处理：
 *      后者会把**我们自己漏写 metadata** 这种真缺陷也 quietly 变成 ignored。
 *      有了标记，两种情形才分得开——
 *        **没标记** = 账户里别人/别的渠道的付款 → 200 + ignored（**不**是我们的问题，不该报警级重试）
 *        **有标记却没有 order_id** = 我们 create 写漏了 → **抛错**（自己的缺陷必须看得见）
 * @limitation 它只覆盖"我们 `create()` 建出来的"付款；**历史数据**（加这个标记之前建的会话）
 *      没有标记，那批事件会被当成"非本系统付款"而 ignored。
 *      @why 可接受：MVP 未上线，没有历史数据；真有历史数据时，正确做法是让它们走对账而不是回调。
 */
export const STRIPE_SOURCE_TAG = 'waselect';

/**
 * Stripe 会话寿命下限：会话创建后 **30 分钟**（三审 A3 / D-49）。
 *
 * @why Stripe 要求 `expires_at` 不早于会话创建后 30 分钟，更早会被 400 拒。
 * @limitation 30 分钟这个数来自 Stripe 文档口径（`NEEDS VERIFICATION`：未做真实 400 实测，
 *      只按官方文档写死）。
 */
export const STRIPE_MIN_SESSION_TTL_SEC = 30 * 60;

/**
 * 在下限之外再留的余量：抵消"我们判定可付的那一刻"与"Stripe 收到请求的那一刻"之间的
 * 网络延迟与两边时钟偏差。2 分钟远大于正常的秒级延迟/偏差。
 */
export const STRIPE_SESSION_MARGIN_SEC = 2 * 60;

/**
 * 算出要发给机构的 `expires_at`（unix 秒）；`req.expiresAt` 缺省时返回 undefined（不发该字段）。
 *
 * 取值 = `订单到期（向上取整） + 30 分钟下限 + 2 分钟余量`——**只由订单决定，与调用时刻无关**。
 *
 * @why 曾经是 `max(订单到期, 现在 + 30 分钟)`（KD-9，AJ-175）：值随调用时刻变化，而意图幂等键
 *      在"建会话失败 → 事务回滚 → 用户重试"时轮次不变（pay-intent.ts intentIdempotencyKey），
 *      于是重试时**同一个幂等键带着不同的 expires_at**——Stripe 对同键异参回 400，
 *      这张单在幂等键 24 小时有效期内再也建不出会话（订单只活 30 分钟，等于这单作废）。
 *      现在同一张单无论何时重试，发给 Stripe 的参数逐字节相同：机构侧幂等照常生效，
 *      "建成了但响应丢了"的重试会拿回同一个会话，不会多出孤儿会话。
 * @why 为什么一定满足 Stripe 下限：能走到建会话，说明订单**尚未到期**（pay-intent 先判 40904），
 *      即 now < 订单到期，于是 订单到期 + 32min > now + 30min。
 * @tradeoff 会话比订单**多活约 32 分钟**：订单关闭后托管页理论上仍可付款。缓解有二：
 *      ① 关单作业/取消的连带订阅者会**主动作废**会话（close-session-events.ts，KD-1 已修）；
 *      ② 到账也会被识别为迟到付款转人工退款（KD-7）。原公式在实际路径上同样让会话比订单多活
 *      （建意图晚于建单，now+30min 本就晚于订单到期），差别只在多出的时长。
 * @limitation 订单支付窗口（ORDER_PAYMENT_TTL_MIN）若配到约 23.5 小时以上，
 *      到期 + 32 分钟会超出 Stripe 的 24 小时上限而被 400——现行口径是 30 分钟（D-33），远离此界。
 * @throws 非法 ISO → 响亮抛错。发 `NaN` 给机构只会得到一句含混的 400，
 *         而"到底是我们传错了还是机构拒了"在那种报错里分不出来。
 */
function sessionExpirySec(expiresAt: string | undefined, orderId: string): number | undefined {
  if (expiresAt === undefined) return undefined;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `expiresAt 不是合法 ISO 时间：${expiresAt}（order=${orderId}；不发 NaN 给机构，那只会得到含混的 400）`,
    );
  }
  return Math.ceil(ms / 1000) + STRIPE_MIN_SESSION_TTL_SEC + STRIPE_SESSION_MARGIN_SEC;
}

/**
 * Stripe Refund.status → 端口的三态（POST 响应与 GET 查询共用一张表，F-03 / AJ-178）。
 *
 * @measured(docs.stripe.com/api/refunds/object, 2026-09-29)：status 取值
 *   `pending` / `requires_action` / `succeeded` / `failed` / `canceled`，且 nullable。
 * @why 只有 `failed` / `canceled` 算"机构确认失败"：它会让下一次重试**换新幂等键**重新发起。
 *      `requires_action`、null、以及将来新增的认不出的状态一律并入 pending——猜成失败的代价
 *      是对一笔可能已在途的退款再发一笔（机构会以"已退款"拒掉，但我们会因此丢掉在途单号），
 *      猜成 pending 的代价只是多等一次查询 / 被每日对账 stuck_refunds 报出。
 *      （旧实现把认不出的一律当 failed——在旧的"失败也同键重试"语义下无害，换键语义下就不行了。）
 */
function refundOutcome(status: unknown): RefundResult['outcome'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'pending';
}

/**
 * 事件类型 → 归一化结果。**未列出的一律 unknown**（不猜）。
 *
 * @why 导出（而不是藏在模块内）：契约的 `x-provider-events.stripe` 清单、本表、
 *      样本工厂的豁免名单是**三方互锁**的同一份事实（test/factories/stripe.contract.test.ts
 *      逐字比对），任何一方改了另两方没变红 = 口径漂移。
 *      契约里订阅但刻意不归一化的事件（refund.updated 等售后后续事件）见该测试的名单。
 */
export const OUTCOME_BY_TYPE: Readonly<Record<string, ProviderEvent['outcome']>> = {
  'checkout.session.completed': 'succeeded',
  'checkout.session.async_payment_succeeded': 'succeeded',
  'checkout.session.async_payment_failed': 'failed',
  'checkout.session.expired': 'expired',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'expired',
  'charge.refunded': 'refunded',
  // ⚠️ `charge.refunded` 事件对象是**整张 Charge**：`amount` 是原扣款全额，退款额在
  //    `amount_refunded`（NEEDS VERIFICATION：官方 changelog 未单列此事件载荷示例，
  //    以 charge 对象结构推定）。F12 售后落账时取 `amount_refunded`，别用 `amount`。
  'charge.dispute.created': 'disputed',
  /**
   * 结案：**开案与结案分开两个 outcome**（@see ports/payment.ts ProviderEvent.outcome）。
   * @limitation 结果（won / lost）不在这个表里——它取决于对象上的 `status`，
   *             不是事件类型能表达的东西，由 `parseWebhook` 单独回带 `disputeStatus`。
   */
  'charge.dispute.closed': 'dispute_closed',
};

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
    // ⚠️ 必须按**原始字节**拼接（官方口径 `HMAC(secret, "{t}.{raw_bytes}")`，三审 S4）。
    //    曾经先 `raw.toString('utf8')` 再拼：合法 UTF-8 时两者一致（所以测试全绿），
    //    但字节流里出现非法 UTF-8 时 `toString` 会把它替换成 U+FFFD ——
    //    **换了一批字节也就换了一个签名**，签名必然不匹配 → 合法回调被判 40103。
    //    那是"安全但错"：fail-closed 保住了钱，代价是"机构侧显示已送达、我们拒收"，
    //    且 40103 不重试，这条事件就此消失，只能靠对账捞。
    const expected = Buffer.from(
      createHmac('sha256', opts.webhookSecret)
        .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]))
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
    // ⚠️ `Number('not-a-number')` 是 NaN，`Math.abs(x - NaN) > 300` 为 false（任何与 NaN 的
    //    比较都 false）——不拦的话畸形时间戳会绕过容差。签名已验过所以实际不可利用，
    //    但"容差失效"本身不该静默（二次审查 P3-12）。
    const tSec = Number(t);
    if (!Number.isFinite(tSec)) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_timestamp_malformed' });
    }
    const nowSec = Math.floor(deps.clock.now().getTime() / 1000);
    if (Math.abs(nowSec - tSec) > STRIPE_TOLERANCE_SEC) {
      throw new AppError(40103, { channel: cfg.channel, reason: 'stripe_timestamp_expired' });
    }
  }

  /**
   * 这个对象是不是**本系统**建出来的（B5 / AJ-198）：看 `metadata.source === 'waselect'`。
   *
   * @see STRIPE_SOURCE_TAG 的 @why（为什么要这个标记、没有它会导致端点被停用）
   */
  function isOurs(obj: Record<string, unknown>): boolean {
    const md = obj['metadata'] as Record<string, unknown> | undefined;
    return md?.['source'] === STRIPE_SOURCE_TAG;
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

  /**
   * Dispute 对象的专用取数通道：**反查 PaymentIntent**。
   *
   * @why Stripe 不会把 metadata 复制到 Dispute 上（与 Charge 不同——Charge 在建单时
   *      会拿到 PaymentIntent 的 metadata 副本），dispute 对象上链回订单的唯一字段是
   *      `payment_intent`；不反查的话 `charge.dispute.*` 事件全部取不到 order_id →
   *      抛错 → 500 → 机构按节奏重发（ bounded 的重试风暴），且 `webhook_events` 里
   *      连一行"收到过"都没有（解析先于登记）——拒付这种"钱在被往回拉"的事件
   *      恰恰是最不能丢审计的一类（体检 P1-7）。
   * @limitation 一次回调多一次出站调用；失败（超时/5xx）则原样抛出让机构重发。
   *             反查拿到的 PI 上也没有 order_id 时同样抛——那才是**我们的**缺陷。
   */
  async function orderIdViaPaymentIntent(pi: string): Promise<string> {
    const res = await deps.http.send({
      method: 'GET',
      url: `${apiBase}/v1/payment_intents/${pi}`,
      headers: { authorization: `Bearer ${opts.secretKey}` },
    });
    if (res.status < 200 || res.status >= 300) {
      // @security 只带状态与前 200 字符：上游错误体可能含 PII，且只进日志
      throw new Error(
        `stripe 反查 payment_intent 失败：HTTP ${res.status} ${res.body.slice(0, 200)}（pi=${pi}）`,
      );
    }
    const json = JSON.parse(res.body) as { metadata?: Record<string, unknown> };
    // B5 / AJ-198：先判"是不是我们的付款"。拒付也可能来自账户里非本系统的收款
    // （Payment Link 收的钱被拒付），那种 dispute 反查回来的 PI 上没有我们的标记——
    // 对它抛错同样会把端点拖向停用。注意区分：**没标记 = 别人的钱**（ignored），
    // **有标记却没有 order_id = 我们写漏了**（抛）。
    if (json.metadata?.['source'] !== STRIPE_SOURCE_TAG) return '';
    const orderId = json.metadata?.['order_id'];
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error(
        `stripe payment_intent 上没有 order_id（pi=${pi}）：create 时未写入 payment_intent_data.metadata`,
      );
    }
    return orderId;
  }

  /**
   * 退款要的 PaymentIntent id：`payments.provider_ref` 登记的是 **Checkout Session**（`cs_…`），
   * 退款 API 只认 PaymentIntent / Charge——会话号要先反查成 PI（KD-11，AJ-175）。
   *
   * @why @measured(docs.stripe.com/api/refunds/create, 2026-09-28)：退款参数只有
   *      `charge`（"The identifier of the charge to refund"）与 `payment_intent`
   *      （"The identifier of the PaymentIntent to refund"），无效标识 "Raises an error"。
   *      原实现把会话号直接当 `payment_intent` 传——**每一笔 Stripe 退款都会失败**，
   *      订单全部停在 refunding；单测与契约测试没发现，是因为单测喂的是 `pi_1`（生产里不存在的形态）、
   *      替身只查"带没带 payment_intent="（替身已加脾气，见 test/helpers/fake-stripe-http.ts @why ②）。
   * @why 在适配器里反查而不是在落账时另存 PI：
   *      ① "会话号 vs PI 号"是 Stripe 私有的 id 族知识，业务核心不该认识（约束四）；
   *      ② 历史订单（修复前已付款的）也能退，不需要数据迁移；
   *      ③ 反查是 GET，天然幂等，重试安全。
   * @tradeoff 每次退款多一次出站调用（退款是低频的人工操作，可接受）。
   * @limitation 会话上 `payment_intent` 为空（未付款的会话，@measured 同上 Session 对象文档示例
   *             `"payment_intent": null`）→ 抛错：没付过款的会话本就不该走到退款。
   *             `pi_…` 直接用；其它前缀（`ch_…` 等）当前不会出现在 provider_ref，出现即抛——不猜。
   */
  async function paymentIntentForRefund(providerRef: string): Promise<string> {
    if (providerRef.startsWith('pi_')) return providerRef;
    if (!providerRef.startsWith('cs_')) {
      throw new Error(`stripe 退款：无法识别的机构单号族（ref=${providerRef}）`);
    }
    const res = await deps.http.send({
      method: 'GET',
      url: `${apiBase}/v1/checkout/sessions/${encodeURIComponent(providerRef)}`,
      headers: { authorization: `Bearer ${opts.secretKey}` },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `stripe 退款前反查会话失败：HTTP ${res.status} ${res.body.slice(0, 200)}（session=${providerRef}）`,
      );
    }
    const json = JSON.parse(res.body) as { payment_intent?: unknown };
    const pi = json.payment_intent;
    // 展开（expand）时是对象：取其 id。两种形态都认，免得哪天加了 expand 参数就静默退不了款
    const id =
      typeof pi === 'string'
        ? pi
        : pi !== null && typeof pi === 'object' && typeof (pi as { id?: unknown }).id === 'string'
          ? (pi as { id: string }).id
          : '';
    if (!id.startsWith('pi_')) {
      throw new Error(
        `stripe 会话上没有 payment_intent（session=${providerRef}）：未付款的会话不能退款`,
      );
    }
    return id;
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
      // ⚠️ 必须在发请求**之前**算：非法 ISO 要在这里响亮抛，不能等机构回 400
      //    （用例「expiresAt 不是合法 ISO → 建会话前抛错」钉的是 http.calls.length === 0）
      const expiresAtSec = sessionExpirySec(req.expiresAt, req.orderId);
      const form = new URLSearchParams({
        mode: 'payment',
        // ── D-49 三项（三审 A3）：缺了哪一条都是"不报错、只在拒付/迟到付款那天才付代价" ──
        // ① 账单地址必收：AVS 与风控的唯一依据，也是拒付抗辩材料（D-50）
        billing_address_collection: 'required',
        // ② 3DS 尽力走：不强制的话 3DS 责任落在我方（D-50 拒付防线）
        'payment_method_options[card][request_three_d_secure]': 'any',
        // ③ 会话到期跟订单走（缺省不发，见 sessionExpirySec 的 @limitation）
        ...(expiresAtSec === undefined ? {} : { expires_at: String(expiresAtSec) }),
        // ⚠️ 显式白名单只收卡（D-49：银行卡通道）：不限制的话 Dashboard 里启用的
        //    任何支付方式都会出现在托管页——其中**异步**方式（银行转账/便利店）会产生
        //    `checkout.session.completed` 但 `payment_status='unpaid'` 的事件，
        //    没有下面的 payment_status 校验就会把"用户还没付钱"置成 paid（二次审查 P2-NEW-1）。
        'payment_method_types[0]': 'card',
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        client_reference_id: req.orderId,
        // B5 / AJ-198：本系统标记（区分"我们的付款"与"账户里别的渠道收的款"，见常量 @why）
        'metadata[source]': STRIPE_SOURCE_TAG,
        'metadata[order_id]': req.orderId,
        'metadata[order_no]': req.orderNo,
        // ⚠️ 这一行是 payment_intent.* 与 charge.* 事件的 order_id **唯一来源**（体检 P1-7）：
        //    Session 级 metadata 只属于 Session 对象；官方口径是"建 Charge 时
        //    PaymentIntent 的 metadata 会复制到 Charge"（之后改 PI metadata 不影响已建 Charge），
        //    所以写进 payment_intent_data 后，payment_intent.succeeded 与 charge.refunded
        //        都能从 object.metadata 取到单号。缺了它，这批事件全进"取不到 order_id → 500"路径。
        // 标记同样要写进 PI：`payment_intent.*` / `charge.*` 事件读的是这一份（B5 / AJ-198）
        'payment_intent_data[metadata][source]': STRIPE_SOURCE_TAG,
        'payment_intent_data[metadata][order_id]': req.orderId,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': req.currency.toLowerCase(),
        // 端口口径：amountMinor 已是整数最小单位（JPY=円、USD=分），这里只透传
        'line_items[0][price_data][unit_amount]': String(req.amountMinor),
        'line_items[0][price_data][product_data][name]': `WaSelect 订单 ${req.orderNo}`,
      });
      // D-60①：收货信息附给 PaymentIntent（Radar 风控 / 拒付举证）。一致性审计 C14（AJ-176）：
      //    D-60 拍板后一直没接，而 D-60 标注的 NEEDS VERIFICATION 已核实——
      //    @measured(docs.stripe.com/api/checkout/sessions/create?query=payment_intent_data, 2026-09-28)：
      //    `payment_intent_data.shipping`「Shipping information for this payment」，`address.line1` 与 `name` 必填，
      //    其余（line2 / city / state / postal_code / country / phone）可选。缺必填时整块不发（不编造）。
      // ⚠️ 表单字段顺序固定、值来自订单快照：同一订单任何时刻重试请求体逐字节相同（KD-9 的前提不被破坏）。
      const ship = req.shipping;
      if (ship !== undefined && ship.name !== '' && ship.line1 !== '') {
        form.set('payment_intent_data[shipping][name]', ship.name);
        form.set('payment_intent_data[shipping][address][line1]', ship.line1);
        const optional: [string, string | undefined][] = [
          ['payment_intent_data[shipping][address][line2]', ship.line2],
          ['payment_intent_data[shipping][address][city]', ship.city],
          ['payment_intent_data[shipping][address][state]', ship.state],
          ['payment_intent_data[shipping][address][postal_code]', ship.postalCode],
          ['payment_intent_data[shipping][address][country]', ship.country],
          ['payment_intent_data[shipping][phone]', ship.phone],
        ];
        for (const [k, v] of optional) if (v !== undefined && v !== '') form.set(k, v);
      }
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
        // B3 / AJ-199：必须是 `ProviderRejectedError` 而不是普通 Error——
        //   "机构给了确定答复"与"结果未知"在业务层是**相反**的处理（换键 vs 不换键）。
        //   Stripe 会把失败结果按幂等键缓存（文档口径：含 500，保留 ≥24 小时），
        //   而订单只活 30 分钟：不换键 = 这张单在整个生命周期内都建不出会话。
        // @security 只带状态与前 200 字符：上游错误体可能含 PII，且只进日志
        throw new ProviderRejectedError(
          res.status,
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
      // Dispute 对象结构上没有我们的 metadata（Stripe 不复制），走反查通道；
      // 其余对象取不到就是 create 时漏写——保持"自己的缺陷必须抛"（见 orderIdOf）
      let orderId: string;
      try {
        orderId = orderIdOf(obj);
      } catch (firstError) {
        const pi = obj['payment_intent'];
        if (obj['object'] === 'dispute' && typeof pi === 'string' && pi.length > 0) {
          orderId = await orderIdViaPaymentIntent(pi);
        } else if (OUTCOME_BY_TYPE[type] !== 'succeeded' && obj['object'] !== 'dispute') {
          // 全量审计 2026-09-26 P1：端点订阅了哪些事件由 Stripe 控制台决定——`balance.available` /
          //    `payout.*` / 控制台手工退款的 `refund.*` / 无 metadata 的 `charge.*` 根本没有我们的单号。
          //    对它们抛错 = 500 → Stripe 按退避重发数天，持续失败的端点会被标记停用，届时真正的
          //    `checkout.session.completed` 也收不到。与订单无关的事件按 unknown 收下（管线 200 +
          //    `ignored:unknown` 留痕）；只有"本该落账却取不到单号"与"拒付却链不回订单"才抛——
          //    前者是我们 create 漏写 metadata，后者是钱正在被拉回、必须有人看见（不能悄悄 ignored）。
          // ⚠️ 2026-09-29 B5（AJ-198）**收窄**了上面这句：这一分支按**事件类型**判断，
          //    挡不住"succeeded 类事件却是账户里非本系统收的款"（Payment Link / Dashboard 收款）——
          //    它同样会走到抛错 → 500 → 端点被停用。那一条由下面的 `!isOurs` 分支兜住。
          //    现在真正会抛的只有一种情形：**有我们的标记、却取不到 order_id**（自己写漏了）。
          orderId = '';
        } else if (!isOurs(obj) && obj['object'] !== 'dispute') {
          // ⚠️ dispute **排除在外**：Stripe 不把 metadata 复制到 dispute 对象上，
          //    所以 dispute 永远"没有标记"——对它不能用 `!isOurs` 判成非本系统，
          //    否则"链不回订单的拒付"会被静默 ignored，而那正是钱正在被拉回、
          //    必须有人看见的一类。dispute 的归属只由**反查 PI** 判定（上面那个分支）；
          //    连 `payment_intent` 字段都没有的 dispute → 落到最后那个 throw。
          // 🔴 B5 / AJ-198：**没有我们的标记 = 这个 Stripe 账户里非本系统收的款**
          //    （Payment Link / Dashboard / Invoice 手工收款）。它们也会打到同一个端点，
          //    而 `metadata.order_id` 理所当然没有。旧实现对它们一律 throw → 500
          //    → Stripe 按退避重发约 3 天 → **持续失败的端点会被停用**，
          //    届时真实订单的 `checkout.session.completed` 也一起收不到（钱收了、订单永远 pending_payment）。
          //    这里按 unknown 收下：**200 + `ignored:unknown` 留痕**（管线给 warn 并写 webhook_events）。
          // @limitation 它**不会**单独打一条 `stripe_foreign_event`：适配器没有 logger（`StripeProviderDeps`
          //    刻意不含它），而 `ProviderEvent` 又明令不许再加字段（ports/payment.ts @limitation 二）。
          //    代价是"非本系统付款"与"我们的 outcome 没注册"在日志里都叫 `ignored:unknown`，
          //    要靠 `raw_type` 区分。**这是可接受的下一次改进点**，不是本次要堵的洞——
          //    本次要堵的是 500（端点被停用），200 + 留痕已经彻底解决它。
          orderId = '';
        } else {
          // 有我们的标记却没有 order_id = **自己 create 时写漏了**，必须看得见（不能 quietly ignored）
          throw firstError;
        }
      }
      const amount =
        typeof obj['amount_total'] === 'number'
          ? obj['amount_total']
          : typeof obj['amount'] === 'number'
            ? obj['amount']
            : undefined;
      const currency =
        typeof obj['currency'] === 'string' ? obj['currency'].toUpperCase() : undefined;
      /**
       * 机构报的对象创建时刻（Stripe 一律 unix **秒**）。
       *
       * @why 只取 `obj.created` 而**不取事件 envelope 的 `created`**：
       *      前者是"这个对象（如 dispute）是什么时候发生的"，后者是"Stripe 什么时候投递这条事件"——
       *      补发/重投时两者可以差好几天，而举证期限要的是前者（@see ports/payment.ts occurredAtMs）。
       * @limitation 只有数字才用；`obj.created` 缺失时**不带这个字段**而不是填当前时间——
       *              让"机构没给"这件事暴露给消费方，由它决定降级还是拒绝，不在这里静默补 0。
       */
      const createdSec = obj['created'];
      /**
       * 拒付对象的机构状态原值（**不映射**，映射属 domain）。
       * @why 只在 `obj.object === 'dispute'` 时才带：这个字段的语义是"这条拒付现在什么状态"，
       *      拿 charge / session 的 `status` 填进来会和"支付状态"混成一团。
       */
      const disputeStatus =
        obj['object'] === 'dispute' && typeof obj['status'] === 'string'
          ? obj['status']
          : undefined;
      // ⚠️ `checkout.session.completed` ≠ 已付款：异步支付方式下 completed 时
      //    `payment_status` 还是 'unpaid'（官方口径：等 `checkout.session.async_payment_succeeded`）。
      //    create() 已用白名单只收卡，这里是**第二道防线**（Dashboard 配置漂移也伤不到落账）：
      //    带 payment_status 且不是 'paid' 的 completed 不归一化成 succeeded（二次审查 P2-NEW-1）。
      const paymentStatus = obj['payment_status'];
      const outcome =
        orderId === '' ||
        (type === 'checkout.session.completed' &&
          typeof paymentStatus === 'string' &&
          paymentStatus !== 'paid')
          ? 'unknown'
          : (OUTCOME_BY_TYPE[type] ?? 'unknown');
      return {
        eventId: typeof ev.id === 'string' ? ev.id : `gen-${deps.idGen.uuid()}`,
        rawType: type,
        outcome,
        orderId,
        providerRef:
          typeof obj['id'] === 'string'
            ? obj['id']
            : typeof obj['payment_intent'] === 'string'
              ? obj['payment_intent']
              : '',
        // ⚠️ 原样回带**最小单位 + 币种**，不换算成 JPY（换算属 domain，用订单的 fx_snapshot）
        ...(amount !== undefined ? { amountMinor: amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(typeof createdSec === 'number' && Number.isFinite(createdSec)
          ? { occurredAtMs: Math.round(createdSec * 1000) }
          : {}),
        ...(disputeStatus !== undefined ? { disputeStatus } : {}),
      };
    },

    async refund(req: RefundRequest) {
      const form = new URLSearchParams({
        // ⚠️ 不是 req.providerRef 本身：那是会话号 cs_…（见 paymentIntentForRefund，KD-11）
        payment_intent: await paymentIntentForRefund(req.providerRef),
        // 原币退（见 RefundRequest.currency 的 @why）：币种与金额都来自**扣款当时**的那笔
        amount: String(req.amountMinor),
        'metadata[order_id]': req.orderId,
        // ⚠️ 不是 req.reason 本身（B7 / AJ-191）：理由原样进 metadata，而 Stripe 对
        //    metadata 的值有长度上限，超了直接拒掉这一整笔退款。
        //    路由入口已经拒掉超长的新理由，这里截断只为**存量**脏数据兜底
        //    （order_events 是 append-only，那些理由改不了），且必须确定性
        //    ——重试之间截出不同文本就是同键异参，机构会 400。
        'metadata[reason]': clipRefundReason(req.reason),
      });
      const res = await deps.http.send({
        method: 'POST',
        url: `${apiBase}/v1/refunds`,
        headers: {
          authorization: `Bearer ${opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // ⚠️ 退款也必须带机构侧幂等键（与 create 同一层防线）：POST 超时后 Stripe 侧
          //    状态未知，而我们按红线**绝不重试无幂等键的 POST**——不带键时超时 = 只能靠
          //    人工再点一次，靠"已全额退款"报错兜底（二次审查 P2-NEW-2）。
          //    键含 orderId：MVP 全额退、一单一退，同一订单的人工重试落到同一键上，
          //    Stripe 会返回第一次的退款而不是再扣一次。
          //    F-03（AJ-178）：上一笔被机构**确认失败**后调用方才把 attempt 加一 → 新键
          //    （同键只会拿回缓存的那次失败）；attempt 0 保持旧键形态，存量重试语义不变。
          'idempotency-key':
            (req.attempt ?? 0) > 0
              ? `refund:${req.orderId}:${String(req.attempt)}`
              : `refund:${req.orderId}`,
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
        outcome: refundOutcome(json.status),
      };
    },

    async refundStatus(refundRef: string) {
      // @measured(docs.stripe.com/api/refunds/retrieve, 2026-09-29)：`GET /v1/refunds/{id}`
      //   "Retrieves the details of an existing refund"；GET 不带幂等键（幂等只对 POST 有意义）。
      const res = await deps.http.send({
        method: 'GET',
        url: `${apiBase}/v1/refunds/${encodeURIComponent(refundRef)}`,
        headers: { authorization: `Bearer ${opts.secretKey}` },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `stripe 查询退款失败：HTTP ${res.status} ${res.body.slice(0, 200)}（refund=${refundRef}）`,
        );
      }
      return refundOutcome((JSON.parse(res.body) as { status?: unknown }).status);
    },

    async expireSession(providerRef: string): Promise<void> {
      // D-50 关单连带：会话即短链跳转目标，订单关单/取消后它必须立刻死，
      // 不能等自然过期（Stripe Checkout 会话最长可活 24h，远长于订单的 30 分钟）。
      const res = await deps.http.send({
        method: 'POST',
        url: `${apiBase}/v1/checkout/sessions/${encodeURIComponent(providerRef)}/expire`,
        headers: {
          authorization: `Bearer ${opts.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // ⚠️ 与 create/refund 同一层防线：POST 超时会话状态未知，我们按红线绝不自动
          //    重试无幂等键的 POST。键含 providerRef：对同一会话的人工/重试落到同一键，
          //    Stripe 返回第一次的结果而不是再炸一次（已 expired 的会话重复 expire
          //    本来就是 400，幂等键让"超时后重发"至少语义确定）。
          'idempotency-key': `expire:${providerRef}`,
        },
        body: '',
      });
      if (res.status < 200 || res.status >= 300) {
        // 调用方（关单订阅者）按 best-effort 兜住：抛出去只是给它一条 warn 的素材
        throw new Error(
          `stripe 会话作废失败：HTTP ${res.status} ${res.body.slice(0, 200)}（session=${providerRef}）`,
        );
      }
    },
  };
}
