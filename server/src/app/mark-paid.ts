/**
 * 职责：**把订单置为 paid**（事务 + `for update` + 追加审计事件）——支付成功的落账动作。
 *
 * @why 从 `skeleton.ts` 搬出来是因为它有**两个调用方**了：
 *      ① 骨架的"模拟触发支付成功"端点；② F11 的统一回调管线（`app/pay-routes.ts`）。
 *      两个入口做同一件事却各写一份，改一处漏一处就会出现
 *      "模拟能过、真实回调失败"这类只在生产暴露的差异。
 *
 * @why 走 `withUnitOfWork`（而不是 `withTransaction`）：置为已支付要发 `order.paid` 事件，
 *      而事件**必须在事务提交之后**分发——否则回滚了订阅者却已经跑过
 *      （@see app/unit-of-work.ts 的 @why）。
 *
 * @limitation 一：接受 `created → paid` 与 `pending_payment → paid` 两条迁移
 *              （I1-U2 起；前者保留给骨架 simulate 路径，U5/U6 真链路落地后随骨架退役）。
 *              "迟到付款 → 自动全额退款"（D-33）**不在本函数**：迟到一律拒落账（见下），
 *              自动退款依赖真实通道退款能力，属售后阶段（I1 方案 §1.3 明示）。
 *              ⚠️ 换的时候**不要**在调用方加 if：调用方只见 `apply` 这一个函数签名，
 *              换实现就换装配处的注入（app/pay-routes.ts 的 `PayRoutesDeps.apply`）。
 * @limitation 一b：**迟到付款守卫**（I1-U2，D-33）：订单 `expires_at` 已到点
 *              （`now >= expires_at`，与关单 job 同一边界方向，见 adapters/orders.ts @why ①）
 *              而回调此时才到 → 抛 40902 `reason:'late_payment'`，**不落账、不封口 payments 行**。
 *              管线的 40902 分支会把它转成 error 级告警 + `late_payment` 登记转对账——
 *              这是"钱扣了但不能发货"的场景，绝不能按普通状态冲突 warn 了事。
 *              关单 job 与守卫是互表里的两道：job 让"到点的单"在数据上死掉，
 *              守卫挡住"死在到账之前的那笔钱"。
 * @limitation 二：状态冲突（不是 `created`）一律抛 **40902**，由回调管线做分层
 *              （已是 paid → `paid:already` 记 info；其它状态 → warn 转对账）。
 *              这里**不**自己决定"要不要忽略"——那是调用方的策略，不是落账动作的事。
 * @limitation 三：**必须带上"钱是怎么来的"**（三审 S1② / U1，本轮已修，不再是欠账）。
 *              落账前逐项核对 `payments` 行与回调自述：通道、机构单号、币种、金额，
 *              任何一项不符 → **40902（带 `reason`）不落账**，由回调管线转 `status_conflict`
 *              + 告警 + 对账（管线只认 40400/40902 两个码，见 pay-callback.ts）。
 *              ⚠️ 为什么用 40902 而不是新增错误码：客户端对"金额不符"与"状态冲突"
 *              的处置一致（都是"别重试，等人工"），新增码要三处同源（shared / 技术文档 §7 /
 *              契约）却换不来任何不同的行为——与 AJ-90 ⑤ 同一个判断。
 *              `reason` 是给日志与对账看的，机器据此分诊。
 *
 * @throws {AppError} 40400（订单不存在）/ 40902（状态不允许本次迁移，或核对不符）
 *
 * @param clock 时钟（注入）：事件时间戳取它，而不是 `new Date()`——
 *              "这个事件发生在什么时候"是业务事实，必须可被测试钉住（@see ports/clock.ts）。
 *
 * @see app/pay-callback.ts（冲突分层）；app/payment-intent.ts（被核对的那一半）；
 *      ports/events.ts；docs/地基搭建清单.md F6c / F11
 */
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import { withUnitOfWork } from './unit-of-work.js';

/**
 * 落账依据的"钱是怎么来的"。**判别联合，调用方必须显式二选一**——
 * 没有"既不传通道也不声明模拟"这条路，少传一个字段就编译不过。
 *
 * @why 做成判别联合而不是可选参数：可选项的代价是"忘记传 = 跳过核对"，
 *      而这个跳过**不报错**（订单照样置 paid），正是 S1② 要堵的那类静默洞。
 */
export type PaidSettlement =
  | {
      kind: 'provider';
      /** 回调来自哪个通道（= `payments.provider`）。 */
      channel: string;
      /** 机构侧会话/交易号（= `payments.provider_ref`）。 */
      providerRef: string;
      /**
       * 机构报的金额（整数最小单位）与币种。**允许 undefined**——
       * 但那意味着"核对不了"，落账会被拒（`settlement_unverifiable`），不是"跳过核对"。
       * @why 不设计成"没报就按我方登记值放行"：金额错配的表现是"少收也发货"，
       *      比收不到钱更难发现，宁可让这一单转对账。
       */
      amountMinor: number | undefined;
      currency: string | undefined;
    }
  /** 骨架的"模拟支付成功"端点：没有机构参与，也就没有可核对的事实。 */
  | { kind: 'simulated' };

/**
 * 核对 `payments` 行与回调自述是否对得上；对不上抛 40902（带 `reason`）。
 *
 * @why 顺序是"通道 → 机构单号 → 币种 → 金额"：前两项是**身份**（谁收的钱），
 *      后两项是**数额**（收了多少）。身份先错就没必要再谈数额，
 *      而告警里最先要看的也正是"钱从一条我没发起过的通道进来"。
 * @limitation 只取**最近一条** `payments` 行（`created_at desc`）。
 *              ⚠️ 换通道重付的场景（旧行 cancelled、新行 initiated）在 I1 状态机里
 *              应当先作废旧行；本函数不猜"该用哪一行"，取最新的那条。
 */
async function assertSettlementMatches(
  tx: Db,
  orderId: string,
  s: Extract<PaidSettlement, { kind: 'provider' }>,
  current: unknown,
): Promise<{ id: string; amountMinor: number; currency: string }> {
  const rows = await tx`
    select id, provider, provider_ref, charge_currency, charge_amount
      from payments
     where order_id = ${orderId}
     order by created_at desc
     limit 1
  `;
  const p = rows[0];
  if (p === undefined) {
    // ⚠️ 没有登记过支付 = 这张单从没发起过支付。此时任何通道的回调都不该落账——
    //    否则"持任一通道密钥 → 给任意订单置 paid"这条链就还是通的
    throw new AppError(40902, { from: current, reason: 'no_payment_intent' });
  }
  if (p.provider !== s.channel) {
    throw new AppError(40902, {
      from: current,
      reason: 'channel_mismatch',
      ctx: { expected: p.provider, got: s.channel },
    });
  }
  // 两边都有值才比：一方为空是"机构没给/没记"，比了只会误报
  if (
    typeof p.provider_ref === 'string' &&
    p.provider_ref.length > 0 &&
    s.providerRef.length > 0 &&
    p.provider_ref !== s.providerRef
  ) {
    throw new AppError(40902, { from: current, reason: 'provider_ref_mismatch' });
  }
  if (s.currency === undefined || s.amountMinor === undefined) {
    throw new AppError(40902, { from: current, reason: 'settlement_unverifiable' });
  }
  if (p.charge_currency !== s.currency) {
    throw new AppError(40902, {
      from: current,
      reason: 'currency_mismatch',
      ctx: { expected: p.charge_currency, got: s.currency },
    });
  }
  if (Number(p.charge_amount) !== s.amountMinor) {
    throw new AppError(40902, {
      from: current,
      reason: 'amount_mismatch',
      ctx: { expected: Number(p.charge_amount), got: s.amountMinor },
    });
  }
  // 收窄后再交回去：调用方拿到的必然是"已核对过"的两个值，不必再判空
  return { id: String(p.id), amountMinor: s.amountMinor, currency: s.currency };
}

export async function markOrderPaid(
  db: Db,
  events: EventBus,
  clock: Clock,
  orderId: string,
  settlement: PaidSettlement,
): Promise<void> {
  await withUnitOfWork(db, events, async (tx, emit) => {
    // for update：并发回调（机构重发）时排队，避免两次都读到待支付态各写一次事件
    const rows = await tx`select status, expires_at from orders where id = ${orderId} for update`;
    const row = rows[0];
    const current = row?.status;
    if (current === undefined) throw new AppError(40400, { order_id: orderId });
    if (current !== 'created' && current !== 'pending_payment') {
      throw new AppError(40902, { from: current, to: 'paid' });
    }
    // ⚠️ 迟到付款守卫（@limitation 一b）：到点即不可付，边界方向与关单 job 一致（含等号）。
    //    判定用注入时钟而不是 DB now()：与关单 job 的 startedAt 同源（应用时钟），
    //    两个判定者用两种时钟会让"恰在边界的那毫秒"出现第三种结果。
    const expiresAt = row?.expires_at as Date | undefined;
    if (expiresAt !== undefined && clock.now() >= expiresAt) {
      throw new AppError(40902, {
        from: current,
        reason: 'late_payment',
        ctx: { expires_at: expiresAt.toISOString() },
      });
    }
    const matched =
      settlement.kind === 'provider'
        ? await assertSettlementMatches(tx, orderId, settlement, current)
        : undefined;
    // 三审（业务一致性 C）：paid_at / 事件 at / order_events.at 三者同源——都取注入时钟。
    //    曾经 paid_at 用 SQL now()，事件用 clock.now()：应用与 DB 不同实例，两者可差数秒，
    //    "什么时候付的"在订单行与事件里各说各话（updated_at 仍用 now()：它是行的技术时间戳，非业务事实）
    const paidAt = clock.now();
    await tx`
      update orders set status = 'paid', paid_at = ${paidAt}, updated_at = now() where id = ${orderId}
    `;
    await tx`
      insert into order_events (order_id, status, actor, at) values (${orderId}, 'paid', 'system', ${paidAt})
    `;
    // 同一事务里把支付行封口：`payments` 是"钱"的账，`orders` 是"货"的账，
    //    两边必须一起提交——分开写会出现"订单已付、支付行还在 initiated"，
    //    而对账任务正是拿 `status='initiated'` 找"收了钱没落单"的
    if (matched !== undefined && settlement.kind === 'provider') {
      await tx`
        update payments
           set status = 'succeeded',
               paid_amount = ${matched.amountMinor},
               paid_currency = ${matched.currency},
               transaction_id = coalesce(transaction_id, ${settlement.providerRef})
         where id = ${matched.id}
      `;
    }
    // 登记（不是分发）：只有这个事务提交成功，订阅者才会收到 order.paid
    emit({ name: 'order.paid', at: paidAt.toISOString(), orderId });
  });
}
