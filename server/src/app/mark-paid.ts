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
 * @limitation 一：这是**骨架期**的落账实现，只处理 `created → paid` 一条迁移。
 *              业务期（I1）会换成真正的订单状态机（`pending_payment → paid`，
 *              且要处理"迟到付款 → 自动全额退款"等分支，见 D-33）。
 *              ⚠️ 换的时候**不要**在调用方加 if：调用方只见 `apply` 这一个函数签名，
 *              换实现就换装配处的注入（app/pay-routes.ts 的 `PayRoutesDeps.apply`）。
 * @limitation 二：状态冲突（不是 `created`）一律抛 **40902**，由回调管线做分层
 *              （已是 paid → `paid:already` 记 info；其它状态 → warn 转对账）。
 *              这里**不**自己决定"要不要忽略"——那是调用方的策略，不是落账动作的事。
 * @limitation 三：**不核对金额与币种**（二次审查 P2-NEW-3）：回调解析出的
 *              `amountMinor / currency` 当前无人消费——骨架期订单没有"应付金额"字段可比对。
 *              ⚠️ I1 状态机接管 `apply` 时**必须**比对回调金额与订单 `charge_amount`：
 *              不符 → 落 unmatched + 告警，**不得**直接置 paid
 *              （金额错配的表现是"少收也发货"，比收不到钱更难发现）。
 *              已登记进 docs/地基搭建清单.md 欠账登记（I1 验收项）。
 *
 * @throws {AppError} 40400（订单不存在）/ 40902（状态不允许本次迁移）
 *
 * @param clock 时钟（注入）：事件时间戳取它，而不是 `new Date()`——
 *              "这个事件发生在什么时候"是业务事实，必须可被测试钉住（@see ports/clock.ts）。
 *
 * @see app/pay-callback.ts（冲突分层）；ports/events.ts；docs/地基搭建清单.md F6c / F11
 */
import type { Db } from '../adapters/db.js';
import { AppError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/events.js';
import { withUnitOfWork } from './unit-of-work.js';

export async function markOrderPaid(
  db: Db,
  events: EventBus,
  clock: Clock,
  orderId: string,
): Promise<void> {
  await withUnitOfWork(db, events, async (tx, emit) => {
    // for update：并发回调（机构重发）时排队，避免两次都读到 'created' 各写一次事件
    const rows = await tx`select status from orders where id = ${orderId} for update`;
    const current = rows[0]?.status;
    if (current === undefined) throw new AppError(40400, { order_id: orderId });
    if (current !== 'created') throw new AppError(40902, { from: current, to: 'paid' });
    await tx`
      update orders set status = 'paid', paid_at = now(), updated_at = now() where id = ${orderId}
    `;
    await tx`
      insert into order_events (order_id, status, actor) values (${orderId}, 'paid', 'system')
    `;
    // 登记（不是分发）：只有这个事务提交成功，订阅者才会收到 order.paid
    emit({ name: 'order.paid', at: clock.now().toISOString(), orderId });
  });
}
