/**
 * 职责：停机流最后一段的**顺序**——先等异步领域事件订阅者跑完，再关连接池（B13 / AJ-202）。
 *
 * @why 抽成函数而不在 `main.ts` 里内联：顺序是这次修复的**全部内容**，
 *      内联在装配处就等于没有任何东西守护它——`main.ts` 是一次性执行的进程入口，
 *      没法在不真正停机的前提下断言"先 drain 后 close"。
 *      抽出来之后顺序可以被单测逐条钉住（`shutdown-cleanup.unit.test.ts`）。
 *
 * @why 只做"等事件"与"关库"这两件事，不多做：停机清理的每一项都是"忘了就静默"，
 *      塞进更多逻辑只会让这里变成第二个没人敢动的装配处。
 *
 * @see ../ports/events.ts（drain 的契约）；../adapters/event-bus.ts（在途集合）；
 *      ./close-session-events.ts（那个"被中断会造成资金事故"的订阅者）
 */
import type { Db } from '../adapters/db.js';
import { closeDb } from '../adapters/db.js';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';

export interface ShutdownCleanupArgs {
  events: EventBus;
  db: Db;
  logger: Logger;
  /** 最多等订阅者多久（毫秒）；0 = 不等直接关库。 */
  drainMs: number;
}

/** 超时后仍有订阅者在途 → 记这条（可检索、可告警）。别改成拼字符串。 */
export const EVENT_DRAIN_TIMEOUT = 'event_drain_timeout';

/**
 * 停机收尾：**先 drain，再 closeDb**，返回仍在途的订阅者数（0 = 都跑完了）。
 *
 * @why 顺序反过来的后果是具体的，不是理论上的：用户取消订单 → 事务提交 → 发
 *      `order.cancelled` → 订阅者（`close-session-events.ts`）去作废机构侧会话 →
 *      此刻进程收到 SIGTERM 并关掉连接池 ⇒ 库内在途行没作废、Stripe 会话没失效，
 *      会话自然过期前（最长约 30 分钟）用户还能付这张**已取消**的单。
 *
 * @why 超时**不抛**：停机流里抛错只会把"清理没干净"变成"退出码 1 但没人知道原因"。
 *      记一条 error 更可检索，且不影响后续清理（关库仍要执行——不关进程会挂住）。
 * @limitation drain 只覆盖**优雅停机**。SIGKILL / OOM / 崩溃时它不会被调用，
 *              那些情形事件照样丢——真正的解法是 outbox，
 *              欠账已登记在 `adapters/event-bus.ts` 的 @upgrade。
 */
export async function drainEventsThenClose(args: ShutdownCleanupArgs): Promise<number> {
  const pending = await args.events.drain(args.drainMs);
  if (pending > 0) {
    args.logger.error(EVENT_DRAIN_TIMEOUT, {
      result: 'timeout',
      ctx: { pending, budget_ms: args.drainMs },
    });
  }
  await closeDb(args.db);
  return pending;
}
