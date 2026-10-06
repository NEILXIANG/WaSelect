/**
 * 职责：**发起支付核心**（I1-U6a）——在给定事务里完成一次支付意图的创建/复用：
 *      锁单 → 守卫 → （复用 | 换通道 | 新建）→ 登记 payments 行 → 迁移 pending_payment。
 *
 * @why 从路由薄壳抽出来（与 createOrder/cancelOrder 同构）：D-49 的 token 轮换、
 *      换通道作废旧意图这些编排要能用**假 Provider 注册表**直接测
 *      （stripe 无密钥时注册不了第二个真实通道，"换通道"就没法测）——
 *      核心可注入，路由与核心测试共用同一份逻辑。
 *
 * @why 幂等键用**确定性派生**而不是随机：`pay-<order>-<channel>`，**第二轮起带轮次** `-<n>`。
 *      同订单同通道重发 = 机构侧同一次创建（mock 的会话缓存 / Stripe 的 Idempotency-Key
 *      都按键去重）——崩溃重试不会造出第二个会话。
 *      ⚠️ 轮次是 2026-09-26 全量审计后加的：换通道 A→B→A 时旧 A 行已 cancelled，
 *         不带轮次的同键会让机构**复放**旧 provider_ref，撞 (provider, provider_ref) 唯一键，
 *         于是被误判成"已有在途支付"。第二轮起必须是新键（见文末 intentIdempotencyKey）。
 * @why 复用时是否再调机构 `create` **分两种**（曾一律重调，2026-09-26 改）：
 *      copylink（行里存了 provider_ref 与 pay_url）→ 直接取回，**不再调 create**：
 *        Stripe 的 expires_at 随调用时刻变化，同键异参会被判 400 idempotency_error
 *        ——用户第二次点"复制链接"直接 500；mock 按键缓存所以当年测试全绿，只有真通道会炸。
 *      in_app（只存 provider_ref，params 没落库）→ 仍以同键重调 create 取回会话视图，
 *        这是通道无关的做法，代价是多一次出站（受总时长预算约束）。
 *
 * @why provider.create **在事务内**调用（已知代价，不是疏忽）：
 *      出站 HTTP 最长占住事务 ~6s（总预算封顶，ports/http-client.ts）。
 *      换来的是"payments 行登记"与"会话创建"原子化：任一步失败整体回滚，
 *      不存在"会话建了但行没登记"的窗口（AJ-93：行不在，回调核不到 → 付了钱落不了账）。
 *      机构侧残留的孤儿会话随 expiresAt 自然死亡（端口已透传订单 TTL）。
 * @tradeoff 订单行锁在 HTTP 期间被持有——MVP 单量下可接受；Stripe 延迟成为问题时
 *      再评估"先提交行、后补 provider_ref"的两阶段形态（那要处理 saga 补偿，更复杂）。
 *      ⚠️ 等待方的体验由 {@link lockOrderForPay} 兜住（等锁超时 → 40903，B6 / AJ-201），
 *      而"能等多久"由连接级 `lock_timeout`（5s）决定——幂等执行器在抢到占位后已把它复位，
 *      否则等待方的预算只有 1ms～2s（adapters/idempotency.ts @limitation 五）。
 *
 * @why copylink 的 token **轮换**（复用也换新）：明文 token 永不落库（库里只有 sha256），
 *      所以"复用时返回同一个链接"在设计上不可能——重新签发并覆盖 hash 是唯一诚实做法。
 *      旧链接立即失效（hash 对不上 → 302 失效页），同一张单同时只有一个活链接。
 *
 * @limitation 一：换通道只作废**我方**的 payments 行，不在本事务里调机构；旧通道的机构会话
 *              由 `order.paid` / `order.cancelled` / `order.expired` 的订阅者在事务提交后作废
 *              （`app/close-session-events.ts`，D-50 / KD-16）。剩余窗口："已换通道、尚未付款"期间旧托管页仍可付
 *              （付了进对账人工退款）。Stripe 会话有效期 = 订单到期 + 32 分钟（KD-9），不是"30 分钟、与订单同源"
 *              （一致性审计 C9 更正）。
 * @limitation 二：扣款币种只看 **provider 能力**（JPY 锚优先，其次 USD 按订单快照换算）；
 *              运营侧的币种开关（ChannelConfig.currencies）是展示层过滤，
 *              用户显式选了通道来到这一步时，能力边界才是硬约束。
 *
 * @see ports/payment.ts（端口）；adapters/orders.ts（SQL）；app/pay-intent-routes.ts（薄壳）；
 *      docs/I1阶段开发实施方案.md §3.6；技术文档 D-49（短链）
 */
import { createHash } from 'node:crypto';
import { isLockNotAvailable, withTransaction, type Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { AppConfig } from '../config.js';
import type {
  PaymentProvider,
  PaymentRegistry,
  PaymentRequest,
  PaymentSession,
  PaymentShipping,
} from '../ports/payment.js';
import { CircuitOpenError } from '../ports/circuit-breaker.js';
import {
  findInitiatedPayment,
  lockOwnedOrderForPay,
  markOrderPendingPayment,
  setPayTokenHash,
  voidInitiatedPayment,
  type OrderPayRow,
} from '../adapters/orders.js';
import {
  countPayCreateFailures,
  recordPaymentIntent,
  updatePaymentProviderRef,
} from './payment-intent.js';
import { ProviderRejectedError } from '../ports/payment.js';
import { asOrderStatus } from '../domain/order.js';
import { toMinor, toRateInt } from '@waselect/shared';

export interface PayIntentDeps {
  config: AppConfig;
  clock: Clock;
  idGen: IdGen;
  logger: Logger;
  registry: PaymentRegistry;
}

export interface PayIntentResult {
  channel: string;
  providerRef: string;
  charge: { currency: string; amount: number };
  payload: Record<string, unknown>;
  expiresAt: Date;
}

/** 扣款币种解析：JPY 锚优先（无换算无精度问题），其次 USD 按订单自己的 fx_snapshot。 */
function resolveCharge(
  capabilities: readonly string[],
  order: OrderPayRow,
): { currency: string; amount: number } {
  if (capabilities.includes('JPY') || capabilities.includes('*')) {
    return { currency: 'JPY', amount: order.total_jpy };
  }
  if (capabilities.includes('USD')) {
    const fx = (order.fx_snapshot ?? {}) as Record<string, unknown>;
    const rate = fx['USD'];
    if (typeof rate !== 'number') {
      // 收钱路径不降级（与报价 50003 同口径）：没有汇率就不猜一个价去收
      throw new AppError(50003, { currency: 'USD', reason: 'charge_needs_snapshot_rate' });
    }
    return { currency: 'USD', amount: toMinor(order.total_jpy, toRateInt(String(rate))) };
  }
  throw new AppError(40001, { reason: 'charge_currency_unsupported', currencies: capabilities });
}

/** 签发短链（D-49）：明文 token 只进响应，sha256 落库；返回拼好的短链。 */
async function issuePayLink(
  tx: Db,
  deps: PayIntentDeps,
  orderId: string,
  expiresAt: Date,
): Promise<Record<string, unknown>> {
  const base = deps.config.CHECKOUT_BASE_URL;
  if (base === undefined) {
    // copylink 通道要求 CHECKOUT_BASE_URL（config 跨字段规则在 stripe 启用时强制；
    // 这里是第二道防线——配置组装错误必须响亮失败，不能发个拼不出来的链接）
    throw new AppError(50000, { reason: 'checkout_base_url_missing' });
  }
  // 两个 uuid 去横线 = 64 hex 字符（128 bit 熵的一半也够：链接有效期 ≤30 分钟）
  const token = `${deps.idGen.uuid().replaceAll('-', '')}${deps.idGen.uuid().replaceAll('-', '')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  await setPayTokenHash(tx, orderId, hash);
  return {
    pay_url: `${base}/o/${orderId}?t=${token}`,
    expires_at: expiresAt.toISOString(),
  };
}

/** 幂等表里代替明文 token 的占位值（落地端点按 hash 比对，占位值永远对不上 → "链接已失效"）。 */
export const PAY_TOKEN_REDACTED = 'redacted';

/**
 * 发起支付的响应体 → **可落库**的形态：抹掉短链里的明文 token（KD-3，AJ-175）。
 * @why D-49"明文 token 永不落库"只守住了 orders.pay_token_hash 这一处，
 *      幂等执行器却把整个响应体（含 `pay_url?t=<明文>`）原样存进 `idempotency_keys.response` 24 小时——
 *      拿到库读权限的人（运维、备份、日志导出）就能直接拼出任何一单的可付款链接。
 * @why 只改 `payload.pay_url` 的 `t` 参数，其余字段原样：重放体的形状必须与首次响应一致。
 */
export function redactPayToken(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  const b = body as { payload?: unknown };
  const payload = b.payload as { pay_url?: unknown } | undefined;
  if (payload === undefined || typeof payload.pay_url !== 'string') return body;
  const u = new URL(payload.pay_url);
  if (!u.searchParams.has('t')) return body;
  u.searchParams.set('t', PAY_TOKEN_REDACTED);
  return { ...b, payload: { ...payload, pay_url: u.toString() } };
}

/**
 * 幂等**重放**时补发短链：重放体里的 token 已被抹掉（{@link redactPayToken}），
 * 订单仍处于待支付且未到期 → 重新签发一次（轮换 token，旧链接随之失效），返回可用的短链；
 * 否则原样返回（占位 token 的链接落地即"已失效"——订单本就不可付了，这正是想要的结果）。
 *
 * @why 与 copylink **复用即轮换**（文件头 @why，D-49）同一语义：重放发生在"客户端没收到首次响应"
 *      或"连点"两种情形，前者手里根本没有旧链接，后者拿到的最新一条就是可用的那条。
 * @tradeoff 重放不再逐字节等于首次响应（pay_url 的 t 不同）。幂等的承诺是"同一次业务操作只做一次"
 *           （没有第二个支付意图、没有第二次机构调用），不是"响应字节不变"——为了字节不变而把
 *           明文存 24 小时，是用安全换一个没有消费方的性质。
 * @limitation **重放体来自同一张单，是本函数安全的前提**：这里把 `replayed` 里的金额原样返回、
 *           只替换 `pay_url`。若重放体其实来自另一张单，产物就是「上一张单的金额 + 这一张单的链接」。
 *           这个前提由调用方的幂等指纹**含 order_id** 保证（`pay-intent-routes.ts`，AJ-195）；
 *            本函数**不**自己复核（查不到"重放体属于谁"——幂等表里只有响应体）。
 *            ⚠️ 因此：谁改了路由的 `request` 指纹，必须回到这里确认一遍，否则不报错、只产出错的钱数。
 */
export async function reissuePayLinkOnReplay(
  db: Db,
  deps: PayIntentDeps,
  input: { orderId: string; userId: string },
  replayed: unknown,
): Promise<unknown> {
  if (replayed === null || typeof replayed !== 'object') return replayed;
  const payload = (replayed as { payload?: { pay_url?: unknown } }).payload;
  if (
    typeof payload?.pay_url !== 'string' ||
    !payload.pay_url.includes(`t=${PAY_TOKEN_REDACTED}`)
  ) {
    return replayed;
  }
  return withTransaction(db, async (tx) => {
    // ⚠️ 与发起支付**同一把锁语义**（AJ-312，第二轮审查 PAY2-08 的修法）：
    //    这里曾经直接调 `lockOwnedOrderForPay`，等锁超时（55P03）原样抛 → 50000
    //    ——用户在重放时看到"服务器内部错误"，而事实只是"另一把键的发起支付正持有这张单"。
    //    重放与首次发起撞同一张单是**正常并发**（幂等重放本就与首次请求竞争），
    //    不该表现成服务端故障。翻成 40903 与 `lockOrderForPay` 同码同义。
    const order = await lockOrderForPayOrNull(tx, input.orderId, input.userId);
    if (
      order === null ||
      asOrderStatus(order.status) !== 'pending_payment' ||
      deps.clock.now() >= order.expires_at
    ) {
      return replayed;
    }
    const fresh = await issuePayLink(tx, deps, input.orderId, order.expires_at);
    deps.logger.info('pay_link_reissued_on_replay', { order_id: input.orderId, result: 'ok' });
    return { ...(replayed as object), payload: { ...payload, ...fresh } };
  });
}

/** 由会话入口构建契约 payload（in_app 透传参数；copylink 发短链）。 */
async function payloadFor(
  tx: Db,
  deps: PayIntentDeps,
  session: PaymentSession,
  orderId: string,
  expiresAt: Date,
): Promise<Record<string, unknown>> {
  if (session.entry.mode === 'copylink') return issuePayLink(tx, deps, orderId, expiresAt);
  if (session.entry.mode === 'redirect') return { url: session.entry.url };
  return { ...session.entry.params };
}

/**
 * 发起/复用支付意图（**必须在调用方的事务里调用**——锁随事务存活）。
 *
 * @throws {AppError} 40400 订单不存在或非本人 | 40902 当前状态不可支付 |
 *         40903 这张单正被另一个请求处理（锁单超时，B6 / AJ-201） |
 *         40904 订单已过期（含"到点未扫"） | 40001 通道不可用/币种不支持 |
 *         50003 扣款所需汇率缺失 | 50000 配置缺 CHECKOUT_BASE_URL
 */
export async function createPayIntent(
  tx: Db,
  deps: PayIntentDeps,
  input: { orderId: string; userId: string; channel: string },
): Promise<PayIntentResult> {
  const { clock, idGen, logger, registry } = deps;

  // ── 1. 持锁读单（归属判定：非本人与不存在同 40400）─────────────────────────
  const order = await lockOrderForPay(tx, input.orderId, input.userId);

  // ── 2. 状态与到期守卫 ────────────────────────────────────────────────────────
  // ⚠️ 顺序（第三轮审查 ORD3-01）：**先**判"已不在可付状态"（40902），**再**判到期（40904）。
  //    原来到期判定在前：已付款 / 已发货 / 已退款的单只要过了 30 分钟窗口，再点支付拿到的都是
  //    40904「订单已过期，请重新下单」——买家照做就会**重复购买**。到期只对可付状态才有意义。
  //    expired 本身不在可付集合里，但它的正确答案仍是 40904（"过期了"比"状态不对"更具体），单独放行到下一步。
  const status = asOrderStatus(order.status);
  if (status !== 'created' && status !== 'pending_payment' && status !== 'expired') {
    throw new AppError(40902, { from: status, to: 'pending_payment', where: 'orders.pay' });
  }
  if (status === 'expired' || clock.now() >= order.expires_at) {
    // "到点未扫"与已关单同码——mark-paid 守卫共享语义（可支付窗口 [created, expires_at)）
    throw new AppError(40904, { order_id: input.orderId });
  }
  if (order.dest_country === null) {
    // 地址快照一定有 country（建单时从 addresses 快照）；没有 = 数据已被写坏
    throw new AppError(50000, { reason: 'dest_country_missing', order_id: input.orderId });
  }

  // ── 3. 通道（注册表统一错误：未注册/已禁用 → 40001）─────────────────────────
  const provider = registry.get(input.channel);

  // ── 4. 在途意图：同通道复用 / 异通道作废重开（D-33）─────────────────────────
  const existing = await findInitiatedPayment(tx, input.orderId);
  const reusing = existing !== null && existing.provider === input.channel;
  if (existing !== null && !reusing) {
    await voidInitiatedPayment(tx, input.orderId);
    logger.info('pay_intent_switched', {
      order_id: input.orderId,
      result: 'ok',
      ctx: { from: existing.provider, to: input.channel },
    });
  }

  // ── 5. 金额与机构会话（确定性幂等键，文件头 @why）───────────────────────────
  // 全量审计 2026-09-26 P1：扣款币种曾只看 Provider 能力（Stripe 能力 JPY+USD → 选 JPY），
  //    而通道**配置**对外宣告的是 USD（`GET /pay/channels?currency=USD` 才列出 stripe，前端按 USD 展示价引导）
  //    → 用户看到 USD、Stripe 却按 JPY 扣，实付由发卡行汇率决定，我方汇率缓冲全部失效。
  //    以"通道在该币种下**对外可见**"为准（与列表接口同一判定），再与能力取交集。
  // 复用时钱按**行里登记的**币种/金额走（mark-paid 只认行里的值）；配置改了币种也不能让响应与会话不一致
  const charge = reusing
    ? { currency: existing.charge_currency, amount: existing.charge_amount }
    : resolveCharge(
        provider.capabilities.currencies.filter((c) =>
          listedFor(registry, input.channel, order, c),
        ),
        order,
      );
  // 全量审计 2026-09-26 P1（两处）：
  //  ① 复用 copylink 意图时**不再回调机构**：行里已存 provider_ref / pay_url。曾经同键重调 create，
  //     而 Stripe 的 expires_at 当时 = max(订单到期, now+30min) 随调用时刻变化（KD-9 后已改为只由订单决定）→ 同一 Idempotency-Key 不同参数
  //     → Stripe 400 idempotency_error → 用户第二次点"复制链接"直接 500（mock 按键缓存所以测试全绿）。
  //  ② 新建意图的幂等键带**轮次**（该单已有几条 payments 行）：换通道 A→B→A 时旧 A 行已 cancelled，
  //     机构按同键复放同一 provider_ref → 撞 (provider, provider_ref) 唯一键 → 被误判成"已有在途支付"。
  //  ③ 幂等键还要带**被拒次数**（B3 / AJ-199）：机构会把**失败结果**按幂等键缓存
  //     （Stripe 官方口径：含 500，保留 ≥24 小时），而订单只活 30 分钟。
  //     不带它 = 首次 5xx 之后这张单在整个生命周期内都建不出会话（事务回滚 → 轮次不变 → 同键）。
  const round = reusing
    ? (await countPayments(tx, order.id)) - 1
    : await countPayments(tx, order.id);
  const attempt = await countPayCreateFailures(tx, order.id, input.channel);
  const session: PaymentSession =
    reusing && existing.pay_url !== null && existing.provider_ref !== null
      ? {
          providerRef: existing.provider_ref,
          entry: { mode: 'copylink', url: existing.pay_url },
          expiresAt: order.expires_at.toISOString(),
        }
      : await createSessionOr50001(provider, deps, {
          orderId: order.id,
          orderNo: order.order_no,
          amountJpy: order.total_jpy,
          currency: charge.currency,
          amountMinor: charge.amount,
          destCountry: order.dest_country,
          idempotencyKey: intentIdempotencyKey(order.id, input.channel, round, attempt),
          expiresAt: order.expires_at.toISOString(),
          shipping: shippingOf(order.address_snapshot),
        });

  // ── 6. 登记 payments 行（复用不建行：同一意图同一行）─────────────────────────
  // 复用但机构给了新会话号（M-03）：改登记新号，否则回调按单号核对对不上、钱到了单不落账
  if (reusing && existing.provider_ref !== session.providerRef) {
    await updatePaymentProviderRef(tx, existing.id, session.providerRef);
  }
  if (!reusing) {
    await recordPaymentIntent(tx, {
      id: `pay-${idGen.uuid()}`,
      orderId: order.id,
      provider: input.channel,
      providerRef: session.providerRef,
      chargeCurrency: charge.currency,
      chargeAmount: charge.amount,
      payUrl: session.entry.mode === 'copylink' ? session.entry.url : undefined,
    });
  }

  // ── 7. 迁移 + payload（copylink 复用也轮换 token，文件头 @why）──────────────
  await markOrderPendingPayment(tx, order.id, clock.now(), `user:${input.userId}`);
  const payload = await payloadFor(tx, deps, session, order.id, order.expires_at);

  logger.info(reusing ? 'pay_intent_reused' : 'pay_intent_created', {
    order_id: order.id,
    channel: input.channel,
    result: 'ok',
    ctx: { charge_currency: charge.currency, charge_amount: charge.amount },
  });
  return {
    channel: input.channel,
    providerRef: session.providerRef,
    charge,
    payload,
    expiresAt: order.expires_at,
  };
}

/**
 * 持锁读单；**另一事务正持有这张单** → 40903「重复提交」而不是 50000（B6 / AJ-201）。
 *
 * @why 发起支付在幂等事务里锁订单行（@see 文件头 @why），因此"两个请求同时为同一张单发起支付"
 *      必然有一个要等锁：先到的持锁做完（含调机构，最长 ~6s），后到的在锁上等。
 *      等锁超时是 **55P03**，而全仓对它的默认处理是折叠成 50000「服务器内部错误」——
 *      用户看到的是"系统坏了"，事实只是"你点快了"。这类并发在本项目里是**正常的**
 *      （弱网下用户连点、两台设备同一单），不该表现成服务端故障。
 * @why 换成 **40903** 而不是新造一个码：40903 在契约里是「重复提交」，语义正是
 *      "同一个操作已经在处理中"——与幂等执行器"抢不到占位"给外部的那个码是同一个，
 *      前端不需要为这条路径学第二种处理（ADR-28：无消费方的字段/码是死数据）。
 * @limitation 只认**锁单这一步**的 55P03：本函数之后的写（`markOrderPendingPayment` 等）
 *              若也撞 55P03，仍然原样抛出——那时的持有者不是"另一笔发起支付"，
 *              把别的写路径的锁冲突也说成"重复提交"会让排障方向从一开始就错。
 * @tradeoff 40903 掩盖了"锁是谁持有的"：关单作业、管理端改单同样会持有这张单，
 *           用户照样看到"重复提交"。可接受——这些都是"这张单现在动不了"，
 *           而精确区分需要暴露内部作业信息，收益不抵。
 */
/**
 * 持锁读单的**唯一实现**：等锁超时 → 40903；行不存在 / 非本人 → `null`（不替调用方决定）。
 *
 * @why 把"55P03 翻成 40903"这一条**只写在这里**（AJ-312）：发起支付与幂等重放都要它，
 *      而 `reissuePayLinkOnReplay` 曾经直接调 `lockOwnedOrderForPay` 裸着用。
 *      两处各写一份的下场就是其中一处（最少被想到的重放路径）忘了翻——
 *      表现是"重放撞上并发 → 50000"，排障时会被当成服务端故障去查。
 * @why 用 `null` 表达"拿不到这张单"而不是抛 40400：两个调用方对它的处置**不同**
 *      （发起支付要 40400；重放要"原样返回重放体"——那张单已经不可付，占位 token 的
 *      链接落地即失效，正是想要的结果）。让调用方决定，本函数不猜。
 */
async function lockOrderForPayOrNull(
  tx: Db,
  orderId: string,
  userId: string,
): Promise<OrderPayRow | null> {
  try {
    return await lockOwnedOrderForPay(tx, orderId, userId);
  } catch (e) {
    if (isLockNotAvailable(e)) {
      throw new AppError(40903, { order_id: orderId, reason: 'pay_in_progress' });
    }
    throw e;
  }
}

async function lockOrderForPay(tx: Db, orderId: string, userId: string): Promise<OrderPayRow> {
  const row = await lockOrderForPayOrNull(tx, orderId, userId);
  if (row === null) throw new AppError(40400, { order_id: orderId });
  return row;
}

/**
 * 地址快照 → 端口的收货信息（D-60①，AJ-176）。快照形状不对（旧数据 / 被写坏）时返回 undefined：
 * 宁可不发，也不编一个半截地址给机构（半截地址在拒付举证时比没有更糟）。
 */
function shippingOf(snapshot: unknown): PaymentShipping | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined;
  const a = snapshot as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : undefined;
  const name = str('recipient');
  const line1 = str('line1');
  if (name === undefined || line1 === undefined) return undefined;
  return {
    name,
    line1,
    line2: str('line2'),
    city: str('city'),
    state: str('state'),
    postalCode: str('postal_code'),
    country: str('country'),
    phone: str('phone'),
  };
}

/**
 * 调机构建会话；**机构侧失败**统一翻成 50001「支付创建失败 → 重试或切换支付方式」。
 *
 * @why 一致性审计 C4（AJ-176）：错误码表（契约 x-error-codes / shared / 技术文档 §7）早就登记了 50001，
 *      全仓却没有一个抛出点——Stripe 回 4xx/5xx 时适配器抛普通 Error，被兜底成 50000"系统繁忙"，
 *      前端给不出"换一种支付方式"的引导。
 * @why 两类**不翻**：`AppError`（适配器自己判定的业务错，如配置缺失 50000）原样抛；
 *      熔断 `CircuitOpenError` 原样抛——它在 errors.ts 映射成 50300 + retry_after，含义是"上游在恢复，稍后再试"，
 *      翻成 50001 会丢掉重试时刻。
 * @limitation 原始错误只进运行日志（`pay_intent_create_failed`，已脱敏），不进响应体。
 */
async function createSessionOr50001(
  provider: PaymentProvider,
  deps: PayIntentDeps,
  req: PaymentRequest,
): Promise<PaymentSession> {
  try {
    return await provider.create(req);
  } catch (e) {
    if (e instanceof AppError || e instanceof CircuitOpenError) throw e;
    /**
     * 机构**明确拒绝**（拿到了非 2xx 的 HTTP 响应）与**结果未知**（超时 / 网络 / 预算耗尽）
     * 在这里分道：前者要把"被拒了一次"交给调用方去记（换键），后者绝不能换键。
     * @see ports/payment.ts 的 ProviderRejectedError（为什么必须由适配器标明）
     */
    const rejected = e instanceof ProviderRejectedError;
    deps.logger.error('pay_intent_create_failed', {
      order_id: req.orderId,
      channel: provider.channel,
      result: 'failed',
      ctx: { definitive: rejected },
      err: e,
    });
    throw new AppError(50001, {
      channel: provider.channel,
      reason: rejected ? 'provider_create_rejected' : 'provider_create_failed',
      // details **只进日志**（errors.ts @limitation 一），但路由靠它决定"要不要在事务外记一笔"
      ...(rejected ? { payCreate: { orderId: req.orderId, channel: provider.channel } } : {}),
    });
  }
}

/**
 * 取出"机构**确认**拒绝建会话"这件事（非此类失败返回 undefined）。
 *
 * @why 路由必须在**事务外**记一笔失败计数（事务回滚会带走它），所以它需要从异常里
 *      知道"是不是这一类失败"。用 details 携带而不是新增 AppError 子类，是为了守住
 *      errors.ts 明写的取舍——"一个错误类 + 一个序列化函数"，不为每个业务各造子类。
 * @limitation 判定只认 `details.payCreate` 这个我们自己写的形状：谁改了上面那处 reason
 *             或字段名而没同步改这里，计数会静默停止（不报错、只是又变回 B3 的老毛病）。
 *             `pay-intent-create-failure.db.test.ts` 用端到端链路钉住它，不靠读源码。
 */
export function payCreateRejectionOf(
  err: unknown,
): { orderId: string; channel: string } | undefined {
  if (!(err instanceof AppError)) return undefined;
  const p = (err.details as { payCreate?: { orderId?: unknown; channel?: unknown } } | undefined)
    ?.payCreate;
  if (typeof p?.orderId !== 'string' || p.orderId.length === 0) return undefined;
  if (typeof p.channel !== 'string' || p.channel.length === 0) return undefined;
  return { orderId: p.orderId, channel: p.channel };
}

/**
 * 意图幂等键：首轮 `pay-<order>-<channel>`（与既有会话兼容），之后带轮次 `-<n>`；
 * 被机构确认拒绝过 `attempt` 次再补 `-f<attempt>`（B3 / AJ-199）。
 *
 * @why 同一订单同一通道的第二轮意图（A→B→A）必须是**新的**机构会话，否则机构复放旧 provider_ref 撞唯一键。
 * @why `-f<n>` 用独立后缀而不是并入轮次数字：轮次与被拒次数是**两个**成因，
 *      合进一个数字会出现"轮次 1、拒 1"与"轮次 11、拒 0"撞键这种看不出来的错位。
 */
function intentIdempotencyKey(
  orderId: string,
  channel: string,
  round: number,
  attempt: number,
): string {
  const base = `pay-${orderId}-${channel}`;
  const withRound = round <= 0 ? base : `${base}-${round}`;
  return attempt <= 0 ? withRound : `${withRound}-f${attempt}`;
}

/** 该单已登记过的 payments 行数（任何状态）——作为新意图幂等键的轮次。 */
async function countPayments(tx: Db, orderId: string): Promise<number> {
  const rows = await tx`select count(*)::int as n from payments where order_id = ${orderId}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * 该通道在 `currency` 下是否对用户可见（与 `GET /pay/channels` 同一判定：enabled + 国家 + 币种）。
 * `'*'` 能力不需要判定（能力本身不指向某个币，交集里保留它由 resolveCharge 按 JPY 处理）。
 */
function listedFor(
  registry: PaymentRegistry,
  channel: string,
  order: OrderPayRow,
  currency: string,
): boolean {
  if (currency === '*') return true;
  const query = { destCountry: order.dest_country ?? '', amountJpy: order.total_jpy, currency };
  return registry.listAvailable(query).some((v) => v.channel === channel);
}
