/**
 * 职责：**工作单元**——一个事务 + "提交之后才分发领域事件"（F10 后半，R2-2）。
 *
 * @why 事件**必须**在事务提交之后分发，顺序反了就是事故：
 *      事务里 emit → 订阅者（将来的发货指令、发券、通知）已经跑了 → 事务随后回滚 →
 *      数据库里根本没有这笔订单，但外部动作已经发生且撤不回来。
 *      这类"幽灵副作用"最难排查：日志里每一步都成功，只有最终状态对不上。
 *
 * @how 回调里的 `emit` **只收集不分发**；`withTransaction` 成功返回（= 已提交）之后才
 *      `publishAll`。事务抛错 → 函数直接抛出 → 收集到的事件随栈一起丢弃，永不分发。
 *      "回滚时不分发"因此不是靠约定，而是靠**代码路径**：那一行根本到不了。
 *
 * @why 放在 `app/`（装配层）而不是 `domain/`：它是**两个适配器的组合**（Postgres 事务 + 事件总线），
 *      本身不含业务规则；放进 domain 会让 domain 认识具体存储，正是分层要防的事。
 *
 * @limitation 一：回调里**禁止再开事务**（`withTransaction` 会抛 "db.begin is not a function"，
 *              见 adapters/db.ts @limitation 二）；需要嵌套单元时用 `withSavepoint`。
 * @limitation 二：`emit` 不代表"已经发生了"。它只是登记意图，**只有事务提交成功才成立**。
 *              订阅者拿到的事件可以信任（到它手上时事务已提交），这是本层存在的全部意义。
 * @limitation 三：分发是**同步发起**的，且发生在返回给调用方之前。
 *              好处：同步订阅者一定已跑完（可测、可推理）。
 *              ⚠️ **async 订阅者不在此列**（B13 / AJ-202 更正）：总线对它们"发后不等"，
 *              `publishAll` 返回时它们可能还在跑——本文件的旧注释把它们也算进
 *              "请求返回时已跑完"，是错的（`close-session-events.ts` 就是 async 订阅者）。
 *              代价：订阅者的同步部分会计入这个请求的响应时间；
 *              异步部分要靠停机前的 `bus.drain()` 收尾（见 app/shutdown-cleanup.ts）。
 *              升级判据（"订阅者开始做网络调用"）**已经满足**——
 *              outbox 现在是已触发的欠账，不是"将来再说"（adapters/event-bus.ts 的 @upgrade）。
 * @limitation 四：总线**理论上**不抛错（见 ports/events.ts 的契约），
 *              但它真抛了的话，本函数会在**事务已提交之后**失败——
 *              即"业务成功、请求报错"。这是刻意的：不吞总线的故障，让它暴露出来。
 *
 * @see ../ports/events.ts；../adapters/event-bus.ts；../adapters/db.ts @limitation 二；
 *      docs/基座缺陷修复方案-2026-09-23.md R2-2；D-50（提交后动作）
 */
import { withTransaction, type Db } from '../adapters/db.js';
import type { DomainEvent, EventBus } from '../ports/events.js';

/** 在事务内登记一个"已发生"的领域事件（真正分发在提交之后，见文件头 @how）。 */
export type Emit = (event: DomainEvent) => void;

/**
 * 在一个事务里执行 `fn`，成功提交后按登记顺序分发它 emit 的事件。
 *
 * @throws fn 抛出的任何错误（事务回滚，**事件不分发**）
 */
export async function withUnitOfWork<T>(
  db: Db,
  bus: EventBus,
  fn: (tx: Db, emit: Emit) => Promise<T>,
): Promise<T> {
  const collected: DomainEvent[] = [];
  const emit: Emit = (event) => {
    collected.push(event);
  };
  const value = await withTransaction(db, (tx) => fn(tx, emit));
  // ⚠️ 这一行的位置就是本文件存在的理由：**只有走到这里，事务才已提交**。
  //    把它挪进上面的回调里，就变成"事务内分发"——回滚了订阅者却已经跑了。
  //    （`unit-of-work.unit.test.ts` 用假 begin 按序断言钉住这个顺序：
  //     注回"事务内分发" → 顺序变成 ['begin','dispatch','commit']，2 条红。）
  bus.publishAll(collected);
  return value;
}
