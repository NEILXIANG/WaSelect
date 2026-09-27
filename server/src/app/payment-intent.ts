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
