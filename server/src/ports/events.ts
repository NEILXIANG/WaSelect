/**
 * 职责：领域事件的**端口**（F10 后半，R2-2）——业务只认"发生了什么"，不认谁在听。
 *
 * @why 没有事件总线时，"下单成功之后要做的事"只能写进下单函数里：
 *      发邮件、扣库存、通知仓库、埋点……每加一件事都要改下单函数，
 *      于是这个函数会变成全站最危险的地方（改它 = 影响所有订单），
 *      而且任何一件后续动作的失败都会把整个下单拖垮。
 *      事件把"下单"和"下单之后"切开：发布方只说"订单已创建"，谁关心谁自己来听。
 *
 * @why 这里是 **v1.2 简化版**：进程内**同步**分发 + 事务提交后执行，不建 outbox 表。
 *      完整形态（跨进程可靠重试）需要 outbox + 投递 worker，MVP 没有第二个进程，
 *      造出来只会多一张表和一个常驻任务。**升级路径写在适配器里**，不是忘了，是推迟。
 *
 * @limitation 一：**订阅者必须是同步的**（返回 `void`）。
 *              总线只保证"同步这一段"不被订阅者拖垮；订阅者里要发 HTTP、要写库，
 *              由它自己 fire-and-forget 并自己兜错——总线收不到它之后的失败。
 *              这是本简化版最大的代价，也是将来上 outbox 的首要理由。
 * @limitation 二：**进程内**意味着事件在进程崩溃时**会丢**（事务提交了、订阅者还没跑完）。
 *              对 MVP 可接受：订阅者目前只做日志；将来订阅者开始做"发发货指令"这类
 *              不可丢的事时，必须先上 outbox（同 @limitation 一）。
 * @limitation 三：`at` 由**发布方**给定，总线不自己 `new Date()`。
 *              理由与本项目其它地方一致：时间是可注入的输入，不是全局状态；
 *              测试里要能钉住它（也便于将来切到 Clock 端口，见 F10 待办）。
 *
 * @see adapters/event-bus.ts（实现）；app/unit-of-work.ts（"提交后才分发"的那层）；
 *      docs/地基搭建清单.md F10；docs/基座缺陷修复方案-2026-09-23.md R2-2；D-50（提交后动作）
 */

/** 领域事件：只描述"发生了什么"，不含"该怎么办"。 */
export interface DomainEvent {
  /** 事件名，点分小写，形如 `order.created`。 */
  name: string;
  /** 发生时刻（ISO 字符串），由发布方给定（见文件头 @limitation 三）。 */
  at: string;
  /** 聚合标识：订单事件就是 `order_id`。用于日志串联与将来对账。 */
  orderId?: string | undefined;
  /** 附加信息。**禁止放原文/敏感字段**——事件会进日志，redact 只认得既有键名。 */
  payload?: Record<string, unknown> | undefined;
}

/**
 * 订阅者。可同步也可 async；抛错 / reject 都由总线兜住（见 {@link EventBus.publish}）。
 * @limitation 总线**发后不等**（fire-and-forget）：async 订阅者的失败只落日志，
 *             发布方拿不到它的结果——需要"必须成功"的动作（发货指令）不能只靠订阅者，
 *             要有自己的重试与对账（F13）。
 */
// 返回类型用 `unknown` 而不是 `void | Promise<void>`：后者会拒绝 `() => arr.push(x)` 这类
// 表达式体（返回 number），迫使调用方到处加花括号；总线在运行期只关心"返回值是不是 Promise"。
export type EventHandler = (event: DomainEvent) => unknown;

export interface EventBus {
  /**
   * 订阅一个事件名。
   * @returns 退订函数（幂等：重复调用无副作用）。
   */
  subscribe(name: string, handler: EventHandler): () => void;

  /**
   * 发布一个事件：**同步**分发给所有订阅者。
   *
   * @why **永不抛错**：订阅者是"别人家的代码"，它的失败不该把发布方的请求打挂——
   *      用户已经下单成功了，不能因为埋点订阅者写错一行就返回 500。
   *      但**绝不静默**：每个失败的订阅者都会落一条 `domain_event_subscriber_failed` error。
   * @why 一个订阅者失败**不影响其它订阅者**：它们是彼此独立的事，
   *      让第一个失败掐掉后面所有订阅，会把"埋点挂了"放大成"发货通知也没了"。
   */
  publish(event: DomainEvent): void;

  /**
   * 按序发布一批（顺序 = 数组顺序）。
   * @why 与"事务里按发生顺序收集、提交后按原序分发"配套：
   *      顺序错了，订阅者看到的因果关系就是反的（先 paid 后 created）。
   */
  publishAll(events: readonly DomainEvent[]): void;
}
