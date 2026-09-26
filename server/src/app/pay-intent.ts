/**
 * 职责：**发起支付核心**（I1-U6a）——在给定事务里完成一次支付意图的创建/复用：
 *      锁单 → 守卫 → （复用 | 换通道 | 新建）→ 登记 payments 行 → 迁移 pending_payment。
 *
 * @why 从路由薄壳抽出来（与 createOrder/cancelOrder 同构）：D-49 的 token 轮换、
 *      换通道作废旧意图这些编排要能用**假 Provider 注册表**直接测
 *      （stripe 无密钥时注册不了第二个真实通道，"换通道"就没法测）——
 *      核心可注入，路由与核心测试共用同一份逻辑。
 *
 * @why 幂等键用**确定性派生**（`pay-{orderId}-{channel}`）而不是随机：
 *      同订单同通道重发 = 机构侧同一次创建（mock 的会话缓存 / Stripe 的 Idempotency-Key
 *      都按键去重）——崩溃重试不会造出第二个会话；复用路径也靠它把"同一份会话视图"
 *      拿回来（我们没存 in_app 的 params，重新调一次 create 用同键取回是通道无关的做法）。
 *
 * @why provider.create **在事务内**调用（已知代价，不是疏忽）：
 *      出站 HTTP 最长占住事务 ~6s（总预算封顶，ports/http-client.ts）。
 *      换来的是"payments 行登记"与"会话创建"原子化：任一步失败整体回滚，
 *      不存在"会话建了但行没登记"的窗口（AJ-93：行不在，回调核不到 → 付了钱落不了账）。
 *      机构侧残留的孤儿会话随 expiresAt 自然死亡（端口已透传订单 TTL）。
 * @tradeoff 订单行锁在 HTTP 期间被持有——MVP 单量下可接受；Stripe 延迟成为问题时
 *      再评估"先提交行、后补 provider_ref"的两阶段形态（那要处理 saga 补偿，更复杂）。
 *
 * @why copylink 的 token **轮换**（复用也换新）：明文 token 永不落库（库里只有 sha256），
 *      所以"复用时返回同一个链接"在设计上不可能——重新签发并覆盖 hash 是唯一诚实做法。
 *      旧链接立即失效（hash 对不上 → 302 失效页），同一张单同时只有一个活链接。
 *
 * @limitation 一：换通道只作废**我方**的 payments 行；旧通道的机构会话不去主动关闭
 *              （Stripe session 30 分钟自然过期，与订单 TTL 同源）。主动关闭属
 *              D-50 关单连带的同款机制（order.cancelled/expired 事件的订阅者，U6a-2）。
 * @limitation 二：扣款币种只看 **provider 能力**（JPY 锚优先，其次 USD 按订单快照换算）；
 *              运营侧的币种开关（ChannelConfig.currencies）是展示层过滤，
 *              用户显式选了通道来到这一步时，能力边界才是硬约束。
 *
 * @see ports/payment.ts（端口）；adapters/orders.ts（SQL）；app/pay-intent-routes.ts（薄壳）；
 *      docs/I1阶段开发实施方案.md §3.6；技术文档 D-49（短链）
 */
import { createHash } from 'node:crypto';
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/ids.js';
import type { AppConfig } from '../config.js';
import type { PaymentRegistry, PaymentSession } from '../ports/payment.js';
import {
  findInitiatedPayment,
  lockOwnedOrderForPay,
  markOrderPendingPayment,
  setPayTokenHash,
  voidInitiatedPayment,
  type OrderPayRow,
} from '../adapters/orders.js';
import { recordPaymentIntent } from './payment-intent.js';
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
  const order = await lockOwnedOrderForPay(tx, input.orderId, input.userId);
  if (order === null) throw new AppError(40400, { order_id: input.orderId });

  // ── 2. 状态与到期守卫（40904 优先于 40902：过期是更具体的拒绝理由）─────────
  const status = asOrderStatus(order.status);
  if (status === 'expired' || clock.now() >= order.expires_at) {
    // "到点未扫"与已关单同码——mark-paid 守卫共享语义（可支付窗口 [created, expires_at)）
    throw new AppError(40904, { order_id: input.orderId });
  }
  if (status !== 'created' && status !== 'pending_payment') {
    throw new AppError(40902, { from: status, to: 'pending_payment', where: 'orders.pay' });
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
  const charge = resolveCharge(provider.capabilities.currencies, order);
  const session = await provider.create({
    orderId: order.id,
    orderNo: order.order_no,
    amountJpy: order.total_jpy,
    currency: charge.currency,
    amountMinor: charge.amount,
    destCountry: order.dest_country,
    idempotencyKey: `pay-${order.id}-${input.channel}`,
    expiresAt: order.expires_at.toISOString(),
  });

  // ── 6. 登记 payments 行（复用不建行：同一意图同一行）─────────────────────────
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
  await markOrderPendingPayment(tx, order.id, clock.now());
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
