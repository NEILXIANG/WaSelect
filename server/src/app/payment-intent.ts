/**
 * 职责：**登记"这笔订单打算怎么收钱"**（写 `payments` 行）——落账核对的**事实来源**。
 *
 * @why 它是"落账绑定通道"（三审 S1② / U1）的另一半，两半缺一就没有意义：
 *      回调说"我在 mock 通道上收到了 12,000 円"，可如果没有一处记录过
 *      "这张单**本来**是要在哪个通道、收多少"，这句话就无从核对——
 *      于是任何持有**任一**通道密钥的人都能给**任意**订单落账（`markOrderPaid`
 *      此前只看订单状态，不看钱是从哪条通道来的）。
 *      登记一次 + 落账时核对一次，这条链才闭合。
 *
 * @why 金额与币种在这里**一次定死**（而不是落账时相信回调）：
 *      下单时的应付额是我们算的（JPY 锚 + 3% 缓冲 + 汇率快照），
 *      回调里的金额是机构报的。两者不符本身就是事故（少收 / 币种错），
 *      必须以**我方**为准去核对方，而不是以对方为准去改账。
 *
 * @limitation 一：生产调用方是 `POST /orders/{id}/pay`（I1-U6a 发起支付）。
 *      （地基期它曾"没有生产调用方"——当时刻意不为了"让它有人用"而造一个
 *      假的发起端点：发起支付是业务动作，地基期固化 I1 的口径代价太大。
 *      那段悬空期由 mark-paid.db.test.ts 与 e2e 走**真函数**兜住。）
 * @limitation 二：一张订单同一时刻只允许一条 `initiated`（001 的部分唯一索引
 *      `uq_payments_one_initiated`）。重复发起 → 40902，由调用方决定"查单重试"还是"报错"。
 *      ⚠️ 换通道重新发起（用户在 mock 上付了一次又去 Stripe）必须先取消旧的那条，
 *      那是 I1 状态机的事，本函数不做"自动作废"。
 *
 * @throws {AppError} 40902（该订单已有在途支付）
 *
 * @see app/mark-paid.ts（核对侧）；docs/地基搭建清单.md 欠账 ②
 */
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';

/** 登记一笔"打算收的钱"。金额一律**整数最小单位**（JPY=円、USD=分）。 */
export interface PaymentIntentInput {
  /** `payments.id`（由调用方注入 `IdGen`，本层不认识 uuid）。 */
  id: string;
  orderId: string;
  /** 通道名（= 注册表 key = 回调时的 `provider`）。 */
  provider: string;
  /** 机构侧的会话/意图号（`create()` 返回的 `providerRef`）。 */
  providerRef: string;
  /** 扣款币种（ISO 4217 大写）。 */
  chargeCurrency: string;
  /** 该币种下的金额，整数最小单位。 */
  chargeAmount: number;
  /** 托管页地址（仅银行卡类通道有；**禁止进日志**，@see redact 的 url 类）。 */
  payUrl?: string | undefined;
}

/**
 * `order_events.status`：机构**确认**拒绝建会话（B3 / AJ-199）。
 *
 * @why 沿用退款 F-03（AJ-178）已经定下的口径——确认失败的次数记在 `order_events` 里，
 *      而不是新开一张计数表：同一件事两种做法，将来一定有人按错的那个去找数。
 *      `order_events` 是 append-only（002 的触发器），天然适合"记一次失败"这种只增的事实，
 *      而且管理端详情（`listEventsFor`）能直接看到"这张单被机构拒了 3 次"——
 *      纯计数表看不到**什么时候**拒的。
 * @why 17 个字符：`order_events.status` 是 `VARCHAR(20)`（001_init.sql）。
 */
export const PAY_CREATE_FAILED_EVENT = 'pay_create_failed';

/** `order_events.note` 的前缀：与退款的 `provider_failed:*`（AJ-178）同一命名，便于一眼看出"机构说的"。 */
function failureNote(channel: string): string {
  return `provider_failed:${channel}`;
}

/**
 * 记一次"机构**确认**拒绝建会话"（B3 / AJ-199）。
 *
 * @why **必须是一次独立的写**，绝不能并进发起支付那个事务：那个事务会在失败时整体回滚，
 *      而这条记数的唯一用途就是**活过回滚**——它要是也被回滚，下一次发起还是同一把幂等键，
 *      而机构会把这次失败按键缓存 ≥24 小时（订单只活 30 分钟）→ 这张单终身付不了。
 * @limitation 因此调用点只能是"事务已经结束之后"（当前是 `pay-intent-routes.ts` 的 catch）；
 *              谁把它挪回事务里，这条修复就静默失效，而且**没有任何测试会红**（回滚是正确行为）。
 */
export async function recordPayCreateFailure(
  db: Db,
  input: { orderId: string; channel: string; actor: string; at: Date },
): Promise<void> {
  await db`
    insert into order_events (order_id, status, note, actor, at)
    values (${input.orderId}, ${PAY_CREATE_FAILED_EVENT}, ${failureNote(input.channel)},
            ${input.actor}, ${input.at})
  `;
}

/**
 * 该单在该通道上"机构确认拒绝建会话"的次数 = 下一次发起要用的 attempt（**换一把新幂等键**）。
 *
 * @why 与"轮次"是两件事：轮次（`payments` 行数）区分"第几个意图"，
 *      attempt 区分"同一个意图被拒了几次"。两者都要进键，缺一个就会撞回缓存的那次失败。
 * @limitation 计数按 `(order_id, channel)` 而不按轮次切片：换通道本身已经换了键，
 *              不必再细分。代价是"曾经失败过"这个事实会一直跟着这张单——
 *              之后每次新建意图的键都带 `-f<n>`，无副作用（键只需要**不同于**上一次）。
 */
export async function countPayCreateFailures(
  db: Db,
  orderId: string,
  channel: string,
): Promise<number> {
  const rows = await db<{ n: number }[]>`
    select count(*)::int as n from order_events
     where order_id = ${orderId}
       and status = ${PAY_CREATE_FAILED_EVENT}
       and note = ${failureNote(channel)}
  `;
  return Number(rows[0]?.n ?? 0);
}

export async function recordPaymentIntent(db: Db, input: PaymentIntentInput): Promise<void> {
  try {
    await db`
      insert into payments (id, order_id, provider, provider_ref, status, charge_currency, charge_amount, pay_url)
      values (${input.id}, ${input.orderId}, ${input.provider}, ${input.providerRef},
              'initiated', ${input.chargeCurrency}, ${input.chargeAmount},
              ${input.payUrl ?? null})
    `;
  } catch (e) {
    // 23505 = unique_violation：这里只可能是"该订单已有在途支付"那一条部分唯一索引
    if ((e as { code?: string }).code === '23505') {
      throw new AppError(40902, {
        from: 'initiated',
        to: 'initiated',
        reason: '该订单已有一笔在途支付：换通道重发必须先作废旧的那条',
      });
    }
    throw e;
  }
}
