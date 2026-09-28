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
 * @limitation 二：**只处理"开案"**（`charge.dispute.created`）。
 *              结案（`charge.dispute.closed` → won/lost + `dispute_closed_at`）**尚未实现**——
 *              它在等 F12 的状态机与真实机构的结案事件形状，现在硬写会写出一个
 *              没人验证过的分支（与 pay-callback.ts @limitation 一 同一个判断）。
 *              ⚠️ 代价：`payments.dispute_status` 一旦置 open 就**永远**是 open，
 *              风控页因此会把已结案的拒付一直显示成进行中。这是**已知缺口**。
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
  /** 机构报的争议金额与币种（与 `payments.charge_*` 核对）。 */
  amountMinor: number | undefined;
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
 * @limitation `channel_mismatch` / `currency_mismatch` / `amount_mismatch` 三个词**复用**
 *              mark-paid 的（语义相同、且已在管线词表里），这里不重复声明——
 *              重复声明就会被 `check:contract` 之类的比对当成两个不同的词。
 * @limitation 词长受 `webhook_events.result` 的 VARCHAR(32) 约束（9 个字符的前缀 `mismatch:`）：
 *              新增词必须 ≤ 23 字符，否则 `resultValue` 会截断、对账检索不到
 *              （`different_dispute_already_open` 就因超长而改用 `dispute_id_conflict`）。
 */
export const DISPUTE_MISMATCH_REASONS = [
  'no_succeeded_payment',
  'dispute_unverifiable',
  'dispute_id_conflict',
] as const;

export async function markOrderDisputed(
  db: Db,
  events: EventBus,
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
    if (Number(p.charge_amount) !== d.amountMinor) {
      throw new AppError(40902, {
        order_id: orderId,
        reason: 'amount_mismatch',
        ctx: { expected: Number(p.charge_amount), got: d.amountMinor },
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
          values (${orderId}, 'dispute_opened', ${d.disputeId}, 'system',
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
      values (${orderId}, 'dispute_opened', ${d.disputeId}, 'system', ${openedAt})
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
