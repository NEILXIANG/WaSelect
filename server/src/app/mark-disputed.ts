/**
 * 职责：把一条**拒付**落进"钱"与"货"两本账（I2 U-F3）——`payments.dispute_*` 四列 +
 *       `orders.has_dispute` + 一条 `order_events`，全部在一个事务里。
 *
 * @why **不迁移订单状态**：拒付发生时货态可能是 paid / shipped / delivered 中的任意一个，
 *      而"这笔钱有争议"是与货态**正交**的资金风险标记。把它硬塞进订单状态机，
 *      要么得给每个货态都加一个 disputed 变体（状态爆炸），要么得破坏
 *      "发货 → 签收 → 完成"这条链（拒付到来时把已发货的单拽回某个中间态）。
 *      代价是"订单状态里看不出有拒付"，由 `has_dispute` 单独回答（管理端风控页读它）。
 *
 * @why 开案时刻（`dispute_opened_at`）取**机构报的时间**，不取入库时刻：
 *      它是**举证期限的起点**（迁移 013）。两者可以相差数小时（回调重试 / 队列积压 /
 *      端点停用后补发），用后者会把举证窗口**算短**——那不是显示错误，是真金白银。
 *      代价：机构没给这个字段时**拒绝落库**（`dispute_unverifiable`）而不是拿 now() 顶上，
 *      因为"有值但错了"比"没有值"更难发现（AJ-159）。
 *
 * @why 时间转换走 SQL 的 `to_timestamp()` 而不是 JS 的 `new Date(ms)`：
 *      ① 绕开 F10 红线（业务侧不得 `new Date()`）——这里是**转换**一个已有数值，
 *         不是读取当前时间，但 AST 规则分不出来，用 SQL 就不必为它开 disable 例外；
 *      ② `payments.dispute_opened_at` 与 `order_events.at` 因此**同源**（同一条 SQL 表达式），
 *         不会出现"两个字段各转一次、精度不同"的裂缝；
 *      ③ 时区处理交给 DB，与库里其它 timestamptz 列一致。
 *
 * @limitation 一：**只补不覆盖**（幂等）。同一个 `dispute_id` 重复到达时**不动 payments**，
 *              只补 `orders.has_dispute` 与事件行。
 *              @why 若每次都写 `dispute_status = 'open'`，一条**旧的** `charge.dispute.created`
 *              重投会把已经 won / lost 的拒付**打回 open**——后台于是显示"有进行中的拒付"、
 *              退款闸门重新锁上，而机构那边早就结案了。这种错误**没有任何一方报错**，
 *              只能靠"重放不得改变已结案状态"这条用例钉住。
 * @limitation 二：开案（`markOrderDisputed`）与结案（`markDisputeClosed`，I2 U-F4 / AJ-162）都已实现；
 *              结案后 `has_dispute`：**lost 保持 true，won 与 withdrawn 复位**
 *              （AJ-176 部分推翻 AJ-162 ③；withdrawn 是 B1 / AJ-193 新增的第三类结案结果）。
 *              （一致性审计 C9 更正：本条原写"结案尚未实现、dispute_status 永远是 open"，U-F4 落地后未回写。）
 * @limitation 三：只取**最近一条** `status='succeeded'` 的支付行（与 mark-paid 同一口径）。
 *              换通道重付的场景（旧行作废、新行 succeeded）里，拒付只会落在新的那条上；
 *              旧行的拒付状态不会同步。MVP 无换通道重付，可接受。
 * @limitation 四：`orders.updated_at` 用 SQL `now()`（行的技术时间戳，非业务事实），
 *              而 `order_events.at` 用开案时刻（业务事实）——两者**刻意不同源**，
 *              与 mark-paid 里"paid_at 用注入时钟、updated_at 用 now()"同一条口径。
 *
 * @see app/pay-callback.ts（按 outcome 分派到这里）；app/mark-paid.ts（对称的另一半：付款落账）；
 *      migrations/013_dispute_opened_at.sql；adapters/risk-admin.ts（管理端读取方）；
 *      docs/自主决策记录.md AJ-159 / AJ-161
 */
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';
import type { DisputeResult } from '../domain/dispute-input.js';
import { withUnitOfWork } from './unit-of-work.js';

/**
 * 落一条拒付所需的"事实"。**全字段必填**（金额/币种/开案时刻允许 undefined，
 * 但语义是"核对不了 → 拒绝落库"，不是"跳过核对"——与 mark-paid 的 PaidSettlement 同口径）。
 */
export interface DisputeSettlement {
  /** 回调来自哪个通道（= `payments.provider`）。 */
  channel: string;
  /** 机构侧拒付单号（写入 `payments.dispute_id`）。 */
  disputeId: string;
  /**
   * 机构报的争议金额（**照它落库**，A4 / AJ-189）。
   * @why 不要求它等于 `payments.charge_amount`：机构官方口径就是"可能不同"
   *      （汇率波动 / 部分争议）。不符时记 warn `dispute_amount_differs` 但照常落库。
   */
  amountMinor: number | undefined;
  /** 机构报的币种；与 `payments.charge_currency` 不同**仍然拒绝**（币种不同无法比较）。 */
  currency: string | undefined;
  /** 开案时刻（unix 毫秒，来自机构报文）。undefined = 机构没给 → 拒绝落库。 */
  openedAtMs: number | undefined;
}

/**
 * 本函数新增的核对失败 reason（回调管线据此把它们与普通过期冲突分层）。
 *
 * @why 单独导出而不是塞进 `SETTLEMENT_MISMATCH_REASONS`：后者是**付款**落账的词表，
 *      拒付有自己的失败形态（`no_succeeded_payment` / `dispute_unverifiable` /
 *      `dispute_id_conflict`）。合进一张表会让"改了付款词表忘了拒付"变成静默漏词。
 * @why 这三个词**必须**进管线的 error 级词表（pay-callback.ts 的 MISMATCH_REASONS）：
 *      不进的话它们会走普通过期冲突那条路——**warn 级 + 2xx**，机构不再重发，
 *      于是"拒付没落库"这件事既不重试也没有 error 告警，举证窗口白白流失。
 * @limitation `channel_mismatch` / `currency_mismatch` 两个词**复用** mark-paid 的
 *              （语义相同、且已在管线词表里），这里不重复声明——
 *              重复声明就会被 `check:contract` 之类的比对当成两个不同的词。
 *              ⚠️ `amount_mismatch` 已于 AJ-189 **从拒付侧移除**（只留在付款落账侧）：
 *              机构的 `Dispute.amount` 官方口径就是"通常等于扣款额，但可能不同"，
 *              把它当错误会让整条拒付消失（`has_dispute` 不置位 → 退款闸门照开）。
 *              两处语义**并不相同**，所以现在它们恰好各归其位。
 * @limitation 词长受 `webhook_events.result` 的 VARCHAR(32) 约束（9 个字符的前缀 `mismatch:`）：
 *              新增词必须 ≤ 23 字符，否则 `resultValue` 会截断、对账检索不到
 *              （`different_dispute_already_open` 就因超长而改用 `dispute_id_conflict`）。
 */
export const DISPUTE_MISMATCH_REASONS = [
  'no_succeeded_payment',
  'dispute_unverifiable',
  'dispute_id_conflict',
  'dispute_not_open',
  'dispute_result_conflict',
  'dispute_result_unknown',
] as const;

/** 结案事实。结果已经过 domain 映射（won / lost / withdrawn）。 */
export interface DisputeClosure {
  /** 回调来自哪个通道（= `payments.provider`）。 */
  channel: string;
  /** 机构侧拒付单号（定位到**哪一条**拒付）。 */
  disputeId: string;
  /** 结案结果（B1 / AJ-193 起含 `withdrawn`：机构撤回、不计输赢）。 */
  result: DisputeResult;
}

/**
 * 落一条**结案**（`charge.dispute.closed`）。
 *
 * @why 结案必须把 `orders.has_dispute` **复位成 false**：
 *      发货/退款闸门（`domain/admin-order-actions.ts` 的 shipGuard / refundGate）
 *      读的就是这个布尔，它们的语义是"**进行中**的拒付"（deny reason 就叫 `dispute_open`）。
 *      结案后不复位 = 这张单**永远**不能发货、不能退款——
 *      那不是"显示不对"，是运营真的做不了事，而且没有任何一方报错。
 *      ⚠️ 这条是 U-F3 留下来的真缺口（它的 @limitation 二：结案未实现），在此补上。
 *
 * @why 结案时刻取**入库时刻**（SQL `now()`）而不是机构时间，与开案相反：
 *      开案时刻是**举证期限的起点**，错不得；结案时刻不是任何期限的起点，
 *      而 Stripe 的 dispute 对象上根本没有"结案时间"这个字段——
 *      能拿到的只有事件 envelope 的投递时刻（U-F1 已明确不取它）。
 *      拿不到就如实用入库时刻，不硬凑。
 *
 * @limitation 一：定位支付行用 `dispute_id` 精确匹配，而不是"最近一条 succeeded"
 *      （开案是后者）。@why 结案是对**某一条具体拒付**的判决，
 *      按"最近一条"找会在"旧拒付已结、新拒付刚开"的边界上判错对象。
 * @limitation 二：已结案且**结果相同** → 幂等不动；结果**不同** → 40902
 *      `dispute_result_conflict`，不静默改判。@why "赢了又改成输了"会影响
 *      财务口径（这笔钱到底算不算损失），必须由人裁决，不能让最后到达的事件说了算。
 *      ⚠️ `withdrawn → won/lost` 同样按冲突处理（B1 / AJ-193）：同一 `dispute_id`
 *      先被撤回、再判出输赢，在机构侧意味着**另一条**拒付（正式拒付有新的 dispute_id），
 *      所以它本就该走 `dispute_not_open`；真撞上同一个 id 时让它响亮失败，
 *      比"悄悄把'机构已撤回'改写成'我方败诉'"安全得多。
 * @limitation 三：只清 `has_dispute`，**不动订单状态**（与开案同一条口径）。
 */
export async function markDisputeClosed(
  db: Db,
  events: EventBus,
  orderId: string,
  c: DisputeClosure,
): Promise<void> {
  await withUnitOfWork(db, events, async (tx, emit) => {
    const orders = await tx`select has_dispute from orders where id = ${orderId} for update`;
    if (orders[0] === undefined) throw new AppError(40400, { order_id: orderId });

    // 行锁顺序与开案一致（先 orders 后 payments）
    const pays = await tx`
      select id, provider, dispute_status
        from payments
       where order_id = ${orderId} and dispute_id = ${c.disputeId}
       limit 1
       for update
    `;
    const p = pays[0];
    if (p === undefined) {
      // 没有这条拒付 = 要么开案事件没到（乱序到达），要么单号对不上。
      // 不"顺手把最近一条支付行结了"——那会结错对象。
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'dispute_not_open',
        ctx: { dispute_id: c.disputeId },
      });
    }
    if (p.provider !== c.channel) {
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'channel_mismatch',
        ctx: { expected: p.provider, got: c.channel },
      });
    }
    const current = p.dispute_status as string | null;
    if (current !== null && current !== 'open') {
      if (current === c.result) return; // 幂等：同一结果的重投什么都不做
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'dispute_result_conflict',
        ctx: { expected: current, got: c.result },
      });
    }

    const rows = await tx`
      update payments
         set dispute_status = ${c.result},
             dispute_closed_at = now()
       where id = ${p.id}
      returning dispute_closed_at
    `;
    const closedAt = (rows[0]?.dispute_closed_at ?? null) as Date | null;
    if (closedAt === null) {
      throw new AppError(50000, { reason: '拒付结案未命中支付行', ctx: { order_id: orderId } });
    }

    // 结案后的 `has_dispute`：**只有 lost 保持 true**；won 与 withdrawn 都复位（B1 / AJ-193）。
    // @why lost 意味着钱已被机构拉回给持卡人：再发货 = 钱货两空；再退款在 Stripe 侧必败——
    //      @measured(docs.stripe.com/error-codes, 2026-09-28)：`charge_disputed`「The charge you're attempting
    //      to refund has been charged back」、`refund_disputed_payment`「You can't refund a disputed payment」。
    //      复位后退款会停在 refunding + 50000，发货则无人拦。AJ-162 只论证了"won 不复位 = 永远不能操作"，
    //      lost 那一半沿用了同一结论；技术文档 D-50 行原本就写着"won 解除 has_dispute"。
    // @why **withdrawn 必须复位**（这就是 B1 修的东西）：查询函（inquiry）以 `warning_needs_response`
    //      开案照样置了 `has_dispute=true`，而它以 `warning_closed` 结案——争议压根没进入正式拒付，
    //      钱没有输掉。旧实现在这条路上抛 `dispute_result_unknown`，`has_dispute` 永远是 true，
    //      于是"机构已经撤回"的订单照样被 40909 / 40907 永久锁死，而全仓只有本函数会写回 false。
    // @tradeoff `has_dispute` 的语义从"有进行中的拒付"扩为"有未解除的拒付限制（进行中，或已败诉）"（契约 0.6.10）。
    //      withdrawn 不在"限制"之列——它不是败诉，也没有待举证的事项。
    await tx`update orders set has_dispute = ${c.result === 'lost'}, updated_at = now() where id = ${orderId}`;
    await tx`
      insert into order_events (order_id, status, note, actor, at)
      values (${orderId}, 'dispute_closed', ${`${c.disputeId}:${c.result}`},
              ${`provider:${c.channel}`}, ${closedAt})
    `;
    emit({
      name: 'order.dispute_closed',
      at: closedAt.toISOString(),
      orderId,
      payload: { dispute_id: c.disputeId, result: c.result },
    });
  });
}

export async function markOrderDisputed(
  db: Db,
  events: EventBus,
  logger: Logger,
  orderId: string,
  d: DisputeSettlement,
): Promise<void> {
  await withUnitOfWork(db, events, async (tx, emit) => {
    /**
     * 行锁顺序：**先 orders 后 payments**，与 mark-paid 一致。
     * @why 两张表都要锁（订单的 has_dispute 与支付行的 dispute_* 必须一起提交），
     *      而两个并发回调若按相反顺序取锁就会死锁——固定顺序是唯一的低成本解法。
     */
    const orders = await tx`select has_dispute from orders where id = ${orderId} for update`;
    const order = orders[0];
    if (order === undefined) throw new AppError(40400, { order_id: orderId });

    const pays = await tx`
      select id, provider, dispute_id, dispute_status, dispute_opened_at,
             charge_currency, charge_amount
        from payments
       where order_id = ${orderId} and status = 'succeeded'
       order by created_at desc
       limit 1
       for update
    `;
    const p = pays[0];
    if (p === undefined) {
      // 没有 succeeded 的支付行 = 这笔钱我们还没收到，拒付无从谈起。
      // 不猜"也许该挂在 initiated 那行上"：那会把"未付款"表现成"已付款但有争议"。
      throw new AppError(40902, { order_id: orderId, reason: 'no_succeeded_payment' });
    }
    if (p.provider !== d.channel) {
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'channel_mismatch',
        ctx: { expected: p.provider, got: d.channel },
      });
    }
    if (d.amountMinor === undefined || d.currency === undefined || d.openedAtMs === undefined) {
      throw new AppError(40902, { order_id: orderId, reason: 'dispute_unverifiable' });
    }
    if (p.charge_currency !== d.currency) {
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'currency_mismatch',
        ctx: { expected: p.charge_currency, got: d.currency },
      });
    }
    /**
     * 金额：**按机构报的落库**，不符**不拒**（A4，AJ-189）。
     *
     * @why 机构（Stripe）官方口径：`Dispute.amount` 通常等于扣款额，但**可能不同**
     *      ——常见原因是汇率波动，或只对订单的一部分发起争议（部分退款后再被拒付）。
     *      旧实现把它当错误拒绝落库，后果是这条拒付**根本进不了系统**：
     *      `orders.has_dispute` 不会置位 → 退款闸门与发货闸门照开 →
     *      钱已经被机构扣回去、我们还在给买家退款 = 钱货两空，且全程无报错。
     * @why 接受它只是"记的金额与扣款额不同"（数字差异、可查、可改），
     *      拒绝它是"整条拒付消失"（行为缺失、无人知晓）——两种错误的方向严重不对等，
     *      按本项目既定的拍板判据（两种错误方向不同时选保守方向），必须选"接受"。
     * @why 差异必须**留痕**（warn 级）：这是财务口径差异，人不看见就等于没发生。
     *      落 `payments.dispute_amount` 的是**机构说的数**——对账要以机构口径为准，
     *      而不是拿我们的扣款额去"纠正"它。
     * @limitation 不自动发起"差额退款"或改订单金额：部分争议怎么处置是业务裁决，
     *              由人在风控页看到这条 warn 后决定（ADR-29：不替人做业务判断）。
     */
    const chargeAmount = Number(p.charge_amount);
    if (chargeAmount !== d.amountMinor) {
      logger.warn('dispute_amount_differs', {
        result: 'accepted',
        order_id: orderId,
        ctx: {
          dispute_id: d.disputeId,
          charge_amount: chargeAmount,
          dispute_amount: d.amountMinor,
          diff: d.amountMinor - chargeAmount,
          currency: d.currency,
        },
      });
    }

    const existingId = p.dispute_id as string | null;
    if (existingId !== null && existingId !== d.disputeId) {
      // 同一笔钱来了两个不同的拒付单号：不覆盖（覆盖会让前一条的证据链丢失），
      // 由人来决定（都记进对账，风控页能看见第一条）。
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'dispute_id_conflict',
        ctx: { expected: existingId, got: d.disputeId },
      });
    }

    const openedAtSec = d.openedAtMs / 1000;

    /**
     * 同一条拒付的重放（@limitation 一）。
     * ⚠️ 这条分支**不写 payments**——写就会把 won/lost 打回 open。
     * 只补 orders 侧：正常路径下它早已是 true，这里防的是"上次写 payments 成功、
     * orders 那条没跟上"的半途状态（跨版本升级或人工修数据时可能出现）。
     */
    if (existingId === d.disputeId) {
      if (order.has_dispute !== true) {
        await tx`update orders set has_dispute = true, updated_at = now() where id = ${orderId}`;
        await tx`
          insert into order_events (order_id, status, note, actor, at)
          values (${orderId}, 'dispute_opened', ${d.disputeId}, ${`provider:${d.channel}`},
                  to_timestamp(${openedAtSec}))
        `;
        emit({
          name: 'order.dispute_opened',
          at: openedAtIso(p.dispute_opened_at, d.openedAtMs),
          orderId,
        });
      }
      return;
    }

    const rows = await tx`
      update payments
         set dispute_id = ${d.disputeId},
             dispute_status = 'open',
             dispute_amount = ${d.amountMinor},
             dispute_opened_at = to_timestamp(${openedAtSec})
       where id = ${p.id}
      returning dispute_opened_at
    `;
    const openedAt = (rows[0]?.dispute_opened_at ?? null) as Date | null;
    // ⚠️ 用 `returning` 拿回 DB 真正存下的时刻，而不是把 `openedAtSec` 再转一遍：
    //    "落进去的是什么"只能由 DB 回答；事件与事件行都用它，三者才真的同源。
    if (openedAt === null) {
      // 走到这里说明 update 没有命中（行在锁期间消失了）——属不变式违反，不能静默
      throw new AppError(50000, { reason: '拒付落库未命中支付行', ctx: { order_id: orderId } });
    }

    await tx`update orders set has_dispute = true, updated_at = now() where id = ${orderId}`;
    await tx`
      insert into order_events (order_id, status, note, actor, at)
      values (${orderId}, 'dispute_opened', ${d.disputeId}, ${`provider:${d.channel}`}, ${openedAt})
    `;
    emit({
      name: 'order.dispute_opened',
      at: openedAt.toISOString(),
      orderId,
      // ⚠️ 只带单号：事件会进日志，机构原文与金额不在 payload 里（ADR-29 脱敏红线）
      payload: { dispute_id: d.disputeId },
    });
  });
}

/**
 * 重放分支里取事件时刻：优先用库里已有的 `dispute_opened_at`。
 *
 * @why 重放时 payments 不写（@limitation 一），所以没有 `returning` 可用；
 *      但那一行**本来就有**开案时刻（否则 existingId 不会等于本次单号）。
 *      它万一为空就退回机构本次报的值——那是同一条拒付的同一个时刻，不是"取当前时间"。
 */
function openedAtIso(stored: unknown, fallbackMs: number): string {
  if (stored instanceof Date) return stored.toISOString();
  // eslint-disable-next-line no-restricted-syntax -- 把机构给的毫秒转成 ISO 字符串，不是读取当前时间（F10 的本意）
  return new Date(fallbackMs).toISOString();
}
