/**
 * 职责：**把订单置为 paid**（事务 + `for update` + 追加审计事件）——支付成功的落账动作。
 *
 * @why 从 `skeleton.ts` 搬出来（F11）是因为它有**两个调用方**了：
 *      骨架的"模拟触发支付成功"端点与统一回调管线（`app/pay-routes.ts`）。
 *      两个入口做同一件事却各写一份，改一处漏一处就会出现
 *      "模拟能过、真实回调失败"这类只在生产暴露的差异。
 *      （骨架端点已随 U6c 退役；本函数留下，唯一调用方是回调管线。）
 *
 * @why 走 `withUnitOfWork`（而不是 `withTransaction`）：置为已支付要发 `order.paid` 事件，
 *      而事件**必须在事务提交之后**分发——否则回滚了订阅者却已经跑过
 *      （@see app/unit-of-work.ts 的 @why）。
 *
 * @limitation 一：允许的迁移交给**状态机迁移表**裁决（domain/order.ts，2026-09-27 起），
 *              本函数不再手写 `status !== 'created' && status !== 'pending_payment'`——
 *              手写一份就是漂移源：表改了这里没改，就变成"状态机说能迁、落账偏不让"，
 *              或者反过来，而两边都能自圆其说、谁也不报错。
 *              ⚠️ 表里 `created → paid` 是**预留边、当前走不到**（原因见 domain/order.ts 该行注释）：
 *                早到回调（回调比"发起支付"的响应先到）实际会被下方 `no_payment_intent` 拒掉——
 *                payments 行与 pending_payment 在同一事务提交，回调到达时行还不可见。
 *                **不是**"允许 created→paid 就能救"：那种情况只能转对账由人工处理。
 *              "迟到付款 → 自动全额退款"（D-33）**不在本函数**：迟到一律拒落账（见下），
 *              自动退款依赖真实通道退款能力，属售后阶段（I1 方案 §1.3 明示）。
 *              ⚠️ 换的时候**不要**在调用方加 if：调用方只见"落账器"这一个函数签名，
 *              换实现就换装配处的注入（挂载处 `appliers.succeeded.apply`，
 *              见 app/pay-callback.ts 的 @see 链——注册表把"哪个 outcome 由谁落"变成了数据）。
 * @limitation 一b：**迟到付款守卫**（I1-U2，D-33）：订单 `expires_at` 已到点
 *              （`now >= expires_at`，与关单 job 同一边界方向，见 adapters/orders.ts @why ①）
 *              而回调此时才到 → 抛 40902 `reason:'late_payment'`，**不落账、不封口 payments 行**。
 *              管线的 40902 分支会把它转成 error 级告警 + `late_payment` 登记转对账——
 *              这是"钱扣了但不能发货"的场景，绝不能按普通状态冲突 warn 了事。
 *              **订单已被关成 expired / cancelled 之后到账，同样按迟到付款**（KD-7，AJ-175）。
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
import { asOrderStatus, canTransition } from '../domain/order.js';
import { withUnitOfWork } from './unit-of-work.js';

/**
 * 落账依据的"钱是怎么来的"。**全字段必填**（金额币种允许 undefined 但语义是"核对不了"
 * 会被拒，见下）——没有"不传通道就跳过核对"这条路，少传一个字段就编译不过。
 *
 * @why 不做成可选参数：可选项的代价是"忘记传 = 跳过核对"，
 *      而这个跳过**不报错**（订单照样置 paid），正是 S1② 要堵的那类静默洞。
 *      （骨架期曾有 `simulated` 变体给模拟端点用；骨架退役后唯一来源就是机构回调，
 *      判别联合随之收敛回单一形状——U6c。）
 */
export interface PaidSettlement {
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
  /**
   * 机构生成"支付成功"事件的时刻（unix 毫秒；Stripe 取事件 envelope 的 `created`，在签名范围内）。
   * @why 判"迟到付款"要看**钱是什么时候付的**，不是通知什么时候到的（M-01）：
   *      窗口最后几秒付的款，通知晚几秒到（网络、机构重投、我们部署重启），原来一律判成迟到付款。
   * @limitation 只用来**放宽**判定：取 `min(它, 我方当前时刻)`，机构时刻在"未来"时按我方时刻算。
   *              缺省 = 机构没给，按我方当前时刻判定（原行为）。
   */
  occurredAtMs?: number | undefined;
}

/**
 * 核对 `payments` 行与回调自述是否对得上；对不上抛 40902（带 `reason`）。
 *
 * @why 顺序是"通道 → 机构单号 → 币种 → 金额"：前两项是**身份**（谁收的钱），
 *      后两项是**数额**（收了多少）。身份先错就没必要再谈数额，
 *      而告警里最先要看的也正是"钱从一条我没发起过的通道进来"。
 * @why 取**在途**（initiated）那一行优先，其次非作废行，最后才按时间（第三轮缺口 P1-3，AJ-385）：
 *      `payments.created_at` 默认 `now()` = **事务开始**时刻。买家连点两个通道时，后拿到订单锁的一方
 *      新插的行时间反而更早、被它作废的旧行更晚——只按 `created_at desc` 取到的是作废那行，
 *      付款成功的回调被判 `channel_mismatch`，钱扣了单不落账。`uq_payments_one_initiated` 保证在途行至多一条。
 * @limitation 没有在途行（已作废 / 已关单）时仍按时间取最新的非作废行，再不行取作废行——
 *              那些情形由迟到守卫与 `duplicate_payment` 分支处理，本函数只负责"选哪一行来核对"。
 */
/** 核对失败的 reason 全集（回调管线据此把它们与普通状态冲突分层）。 */
export const SETTLEMENT_MISMATCH_REASONS = [
  'no_payment_intent',
  'channel_mismatch',
  'provider_ref_mismatch',
  'currency_mismatch',
  'amount_mismatch',
  'settlement_unverifiable',
  // M-02：订单已付后又来一笔**另外的**支付成功（换通道后旧页面又被付了一次 / 付了旧会话）
  'duplicate_payment',
] as const;

async function assertSettlementMatches(
  tx: Db,
  orderId: string,
  s: PaidSettlement,
  current: unknown,
): Promise<{ id: string; amountMinor: number; currency: string }> {
  const rows = await tx`
    select id, provider, provider_ref, charge_currency, charge_amount
      from payments
     where order_id = ${orderId}
     order by (status = 'initiated') desc, (status = 'cancelled') asc, created_at desc
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
  // 两边都有值才比：一方为空是"机构没给/没记"，比了只会误报。
  // ⚠️ 且只在**同一 id 族**内比（全量审计 2026-09-26）：Stripe 登记的是 Checkout Session（`cs_…`），
  //    而 `payment_intent.succeeded` 事件回带的是 `pi_…`、`charge.*` 回带 `ch_…`——同一笔钱三种 id。
  //    跨族硬比会把每一单 PI 先到的正常回调判成 provider_ref_mismatch（现在是 error 级 + 进对账）。
  //    跨族时放弃单号核对，仍由通道 / 币种 / 金额三项兜住。
  if (
    typeof p.provider_ref === 'string' &&
    p.provider_ref.length > 0 &&
    s.providerRef.length > 0 &&
    sameRefFamily(p.provider_ref, s.providerRef) &&
    p.provider_ref !== s.providerRef
  ) {
    throw new AppError(40902, {
      from: current,
      reason: 'provider_ref_mismatch',
      ctx: { expected: p.provider_ref, got: s.providerRef },
    });
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

/**
 * "关闭且未收款"的终态：此时到账一律按迟到付款处理（KD-7，见 markOrderPaid 内注释）。
 * @why 集合而不是 `from === 'expired'`：新增一种"未收款即关闭"的终态时只改这里。
 */
const CLOSED_UNPAID: ReadonlySet<string> = new Set(['expired', 'cancelled']);

export async function markOrderPaid(
  db: Db,
  events: EventBus,
  clock: Clock,
  orderId: string,
  settlement: PaidSettlement,
): Promise<void> {
  try {
    await settle(db, events, clock, orderId, settlement);
  } catch (e) {
    if (
      e instanceof AppError &&
      (e.details as { reason?: unknown } | undefined)?.reason === 'late_payment'
    ) {
      await recordLatePaid(db, clock, orderId, settlement);
    }
    throw e;
  }
}

/**
 * 迟到付款留凭据：`order_events` 记一条 `late_paid`（note = 机构单号，actor = provider:<通道>）。
 *
 * @why 落账事务已因 late_payment 回滚，凭据必须**另起一条语句**写——放进同一事务会随回滚消失。
 *      它是管理端退款闸门放行已关单的唯一依据（剩余清单 1-5 / AJ-368）：
 *      不留凭据，运营只能去机构后台手退，系统里没有任何"这单收过钱、已退"的痕迹。
 * @why 不改订单状态：订单在我方账上从没收过钱（paid_at 仍为空），关单时库存也已回补；
 *      买家时间线只取订单状态值，这条事件对买家不可见。
 * @why 同一机构单号只记一次（重投 / 同一笔钱的另一种事件），由 `not exists` 去重。
 * @limitation 同一笔钱以两种单号族到达（cs_ 与 pi_）会各记一条；退款按订单只退一次（幂等键 refund:<orderId>），
 *             多一条凭据不会多退钱，只是事件流里多一行。
 * @limitation 凭据写失败（库不可用）会顶替原 40902 抛出 → 管线回 5xx、机构重投，下一次再写。
 */
async function recordLatePaid(
  db: Db,
  clock: Clock,
  orderId: string,
  s: PaidSettlement,
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    select ${orderId}, 'late_paid', ${s.providerRef}, ${`provider:${s.channel}`}, ${clock.now()}
     where exists (select 1 from orders where id = ${orderId})
    -- 审计 BUG-13（2026-10-14，AJ-529）：去重交给部分唯一索引 uq_order_events_late_paid（迁移 040）。
    --   原先 where not exists 在事务外、无锁，并发两条同单号回调都看不到对方 ⇒ 两条凭据。
    on conflict (order_id, note) where status = 'late_paid' do nothing
  `;
}

async function settle(
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
    // 迁移合法性问状态机（@limitation 一）。`asOrderStatus` 对枚举外的脏状态抛 50000：
    //    库里的状态超出枚举 = 数据已被写坏，不能当成"不可迁移"糊过去。
    const from = asOrderStatus(current);
    // ⚠️ **已关单的到账 = 迟到付款**（KD-7，2026-09-28 测试审查实测；AJ-175 拍板）：
    //    关单作业每分钟一轮，迟到的钱多数时候碰到的已经是 `expired`（用户取消的则是 `cancelled`）。
    //    原实现先问状态机、`expired → paid` 不合法 → 不带 reason 的 40902 → 管线按普通状态冲突记 warn +
    //    `ignored:status_conflict`，只有"关单作业还没跑到"的几十秒内到账才被识别为 late_payment——
    //    同一件事（钱扣了、单已关、必须人工退款）按到达时刻分成两种分类与两种告警级别。
    //    现在两种情形统一：订单已处于"关闭且未收款"终态时，一律 `reason:'late_payment'`。
    //    @tradeoff cancelled 也归入 late_payment 而不是新造一个 `closed_payment`：运营动作完全相同（退款），
    //    多一个词只多一条对账分支；区分"是过期还是取消"看 `details.from`，日志里有。
    if (CLOSED_UNPAID.has(from)) {
      // 审计 BUG-08（2026-10-14，AJ-530）：同通道已有 succeeded 支付行 = 这笔钱早已落过账（审核期测试单付款满 24h 被归档成
      //   cancelled，支付行不动）。机构重投它不是"迟到付款"——原先会写出假的 late_paid 凭据、进「迟到付款待退」待办，
      //   退款闸门还会因此放行。按普通状态冲突处理（管线记 ignored:status_conflict）。
      const settled = await tx`
        select 1 from payments
         where order_id = ${orderId} and provider = ${settlement.channel} and status = 'succeeded'
         limit 1`;
      if (settled.length > 0) {
        throw new AppError(40902, {
          from,
          to: 'paid',
          where: 'mark-paid',
          reason: 'already_settled',
        });
      }
      // 先核对再判迟到（第三轮缺口 P2-3，AJ-385）：本机实测金额不符的回调被归为 late_payment、记了 late_paid 凭据，
      // 管理端随后按支付行 charge_amount 退款——而实收是另一个数。对不上的走 mismatch 进对账，不留迟到凭据。
      await assertSettlementMatches(tx, orderId, settlement, from);
      throw new AppError(40902, {
        from,
        reason: 'late_payment',
        ctx: { closed_as: from },
      });
    }
    if (!canTransition(from, 'paid')) {
      // 已收过钱的单又来一笔"支付成功"（M-02）：先判断是不是**同一笔钱**的重复通知。
      // 原实现在这里一律抛 {from}，管线按 paid:already 记 info、不进对账——
      // 换通道后旧的 Stripe 页面又被付了一次，那第二笔真实扣款就被静默吞掉。
      if (await isAnotherPayment(tx, orderId, settlement)) {
        throw new AppError(40902, {
          from,
          reason: 'duplicate_payment',
          ctx: { channel: settlement.channel, provider_ref: settlement.providerRef },
        });
      }
      throw new AppError(40902, { from, to: 'paid', where: 'mark-paid' });
    }
    // ⚠️ 迟到付款守卫（@limitation 一b）：到点即不可付，边界方向与关单 job 一致（含等号）。
    //    判定用注入时钟而不是 DB now()：与关单 job 的 startedAt 同源（应用时钟），
    //    两个判定者用两种时钟会让"恰在边界的那毫秒"出现第三种结果。
    const expiresAt = row?.expires_at as Date | undefined;
    // 判定时刻 = 付款发生时刻（机构报的，M-01）与我方当前时刻取早者：
    //   通知晚到不算迟到；机构时刻在"未来"（时钟偏差）时按我方时刻算，不能借它绕开窗口。
    const nowMs = clock.now().getTime();
    const paidMoment =
      settlement.occurredAtMs !== undefined && Number.isFinite(settlement.occurredAtMs)
        ? Math.min(settlement.occurredAtMs, nowMs)
        : nowMs;
    if (expiresAt !== undefined && paidMoment >= expiresAt.getTime()) {
      await assertSettlementMatches(tx, orderId, settlement, from); // 同上（P2-3）
      throw new AppError(40902, {
        from,
        reason: 'late_payment',
        ctx: { expires_at: expiresAt.toISOString() },
      });
    }
    const matched = await assertSettlementMatches(tx, orderId, settlement, from);
    // 三审（业务一致性 C）：paid_at / 事件 at / order_events.at 三者同源——都取注入时钟。
    //    曾经 paid_at 用 SQL now()，事件用 clock.now()：应用与 DB 不同实例，两者可差数秒，
    //    "什么时候付的"在订单行与事件里各说各话（updated_at 仍用 now()：它是行的技术时间戳，非业务事实）
    const paidAt = clock.now();
    await tx`
      update orders set status = 'paid', paid_at = ${paidAt}, updated_at = now() where id = ${orderId}
    `;
    await tx`
      insert into order_events (order_id, status, actor, at)
      values (${orderId}, 'paid', ${`provider:${settlement.channel}`}, ${paidAt})
    `;
    // 同一事务里把支付行封口：`payments` 是"钱"的账，`orders` 是"货"的账，
    //    两边必须一起提交——分开写会出现"订单已付、支付行还在 initiated"，
    //    而对账任务正是拿 `status='initiated'` 找"收了钱没落单"的
    await tx`
      update payments
         set status = 'succeeded',
             paid_amount = ${matched.amountMinor},
             paid_currency = ${matched.currency},
             transaction_id = coalesce(transaction_id, ${settlement.providerRef})
       where id = ${matched.id}
    `;
    // 登记（不是分发）：只有这个事务提交成功，订阅者才会收到 order.paid
    emit({ name: 'order.paid', at: paidAt.toISOString(), orderId });
  });
}

/**
 * 这次"支付成功"是不是一笔**另外的**钱（订单已经收过一笔，M-02）。
 *
 * 判据（只在能证明"不是同一笔"时返回 true，证明不了就按重复通知处理）：
 *   ① 订单上已收款的支付行（succeeded / refunded）都不是这个通道 → 另一笔；
 *   ② 同通道的行里有与本次单号**同一 id 族**的单号（provider_ref / transaction_id），却没有一个相等 → 另一笔；
 *   ③ 同通道但没有同族单号可比（Stripe 登记 cs_、事件回带 pi_）→ 证明不了，按重复通知。
 * @tradeoff ③ 放行意味着"同通道、跨族"的第二笔钱仍可能被当成重复通知；要彻底区分需要按机构对象反查
 *           （cs_ ↔ pi_ 关联），留给对账。①② 覆盖了已知的两条触发路径（换通道、付了旧会话）。
 */
async function isAnotherPayment(tx: Db, orderId: string, s: PaidSettlement): Promise<boolean> {
  const rows = await tx`
    select provider, provider_ref, transaction_id
      from payments
     where order_id = ${orderId} and status in ('succeeded', 'refunded')
  `;
  if (rows.length === 0) return false; // 没有已收款行：不是这里能判断的形态，按原分支处理
  const sameChannel = rows.filter((r) => r['provider'] === s.channel);
  if (sameChannel.length === 0) return true;
  if (s.providerRef.length === 0) return false;
  const comparable = sameChannel
    .flatMap((r) => [r['provider_ref'], r['transaction_id']])
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .filter((x) => sameRefFamily(x, s.providerRef));
  return comparable.length > 0 && !comparable.includes(s.providerRef);
}

/**
 * 两个机构单号是否属于同一 id 族（前缀到第一个 `_` 为止；无下划线的视为同族——mock 等自定义 ref）。
 * @measured Stripe 对象 id 形如 `cs_test_…` / `pi_…` / `ch_…` / `re_…`，族名是第一段（test/factories/stripe.ts 样本一致）。
 */
// @limitation 跨族放行意味着 Stripe 上单号核对只对 `checkout.session.*` 事件生效；`payment_intent.succeeded`
//             先到时凭通道/币种/金额落账。A→B→A 后用户若付了**旧** cs 会话，PI 事件同样能落账——钱是真的、
//             金额对，但 transaction_id 指向旧会话；旧会话不主动作废是 pay-intent 的既有 @limitation。
function sameRefFamily(a: string, b: string): boolean {
  const fam = (x: string): string => (x.includes('_') ? x.slice(0, x.indexOf('_')) : '');
  return fam(a) === fam(b);
}
