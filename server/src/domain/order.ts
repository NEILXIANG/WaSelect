/**
 * 职责：订单状态机的**唯一迁移表**（I1-U5b）——10 态、谁能迁到哪，全仓库只有这一份。
 *
 * @why 迁移规则不得散写（方案 §4.2）：job（超时关单）、路由（取消/支付）、落账（mark-paid）
 *      三处各自判断"这个状态能不能到那个状态"的话，加一条迁移要改三处，
 *      漏改的那处就是"文档说能迁、代码不让迁"或反过来——而且两边都能自圆其说。
 *      集中成一张表后，"现在一共有多少条合法迁移"有一个地方能回答。
 *
 * @why 表是**数据**（Record<from, to[]>）而不是 switch：数据可以被测试整体断言
 *      （键集合 === ORDER_STATUS、空数组集合 === TERMINAL_ORDER_STATUS），
 *      switch 的分支只能逐条用例覆盖，漏一条分支没人知道。
 *
 * @limitation 一：表与技术文档 §1 逐字一致（含"退款失败停留 refunding 不算迁移"——
 *              refunding → refunding 不在表里，失败重试由管理端重发触发，不经过状态迁移）。
 * @limitation 二：`assertTransition` 只是**迁移合法性**判定，不含"能不能操作"的全部语义
 *              （如 mark-paid 的迟到守卫、取消时的 payments 行作废）——那些是各调用点自己的
 *              业务规则，本表只回答"这条迁移在状态机里存不存在"。
 * @limitation 三：本表**不读库**——当前状态从库里读出来是 string，调用方须先经
 *              `isOneOf(ORDER_STATUS, ...)` 收窄（脏状态在边界上挡，不进本表）。
 *
 * @see 技术文档 §1（状态机迁移表，本表的唯一上游）；packages/shared/src/enums.ts（10 态枚举）；
 *      docs/I1阶段开发实施方案.md §4.2
 */
import { ORDER_STATUS, type OrderStatus } from '@waselect/shared';
import { AppError } from '../errors.js';

/** 迁移表（与技术文档 §1 的"可转到"列逐字一致）。 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['pending_payment', 'cancelled', 'expired'],
  pending_payment: ['paid', 'expired', 'cancelled'],
  paid: ['shipped', 'refunding'],
  shipped: ['delivered', 'refunding'],
  delivered: ['completed', 'refunding'],
  completed: [],
  cancelled: [],
  expired: [],
  refunding: ['refunded'],
  refunded: [],
};

/** from → to 是状态机里的合法迁移吗。 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * 断言迁移合法，否则抛 40902（订单状态不允许此操作）。
 * @param where 调用点标识（只进 details 日志：同一张单被 job/路由/落账三处碰时，要知道是谁拒的）
 */
export function assertTransition(from: OrderStatus, to: OrderStatus, where: string): void {
  if (!canTransition(from, to)) {
    throw new AppError(40902, { from, to, where });
  }
}

/** 库行状态字符串 → OrderStatus（脏数据抛 50000：库里的状态超出枚举 = 数据已被写坏）。 */
export function asOrderStatus(raw: unknown): OrderStatus {
  const s = String(raw);
  if ((ORDER_STATUS as readonly string[]).includes(s)) return s as OrderStatus;
  throw new AppError(50000, { reason: 'order_status_out_of_enum', value: s });
}
