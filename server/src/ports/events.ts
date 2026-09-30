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
 * @limitation 一：订阅者**可以 async**，但总线**发后不等**（fire-and-forget）——
 *              `publish` 返回时 async 订阅者可能还在跑，它的失败只落日志（见 {@link EventHandler}）。
 *              因此**停机前必须调一次 {@link EventBus.drain}**：否则部署窗口内
 *              "事务已提交、订阅者还没跑完就进程退出"就是常态而不是意外
 *              （B13 / AJ-202：`order.cancelled` 的会话作废被中断 ⇒ 已取消的单还能付款）。
 *              这是本简化版最大的代价，也是将来上 outbox 的首要理由。
 * @limitation 二：**进程内**意味着事件在进程崩溃时**会丢**（事务提交了、订阅者还没跑完）。
 *              对 MVP 可接受的前提是"订阅者只做日志"——**这个前提已经不成立了**
 *              （`app/close-session-events.ts` 会调机构作废会话，见 B13 / AJ-202），
 *              所以现在的缓解手段是 `drain()` + 会话自然过期兜底；
 *              真正要杜绝"丢了"仍然只有 outbox 一条路（升级路径见 adapters/event-bus.ts 的 @upgrade）。
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
 *             要有自己的重试与对账（F13）；
 *             停机前要等它跑完则走 {@link EventBus.drain}。
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

  /**
   * 等在途的 **async 订阅者**跑完（停机前必须调一次，见 @limitation 一）。
   *
   * @param timeoutMs 最多等多久；到点仍在途的订阅者**不再等**（停机不能无限延后）。
   * @returns 到点后**仍在途**的订阅者数量；`0` = 在超时前全部跑完。
   *
   * @why 总线是"发后不等"的（{@link EventBus.publish}），所以"订阅者有没有跑完"
   *      这件事**只有总线自己知道**——调用方想等也无从下手。
   *      停机流若直接 `closeDb`，在途订阅者会拿到"连接池已关闭"，
   *      表现为"B13：用户取消订单后会话没作废、已取消的单在会话自然过期前还能付款"。
   * @why 返回"仍在途的数量"而不是布尔：调用方要拿它决定**是否记 error**
   *      （>0 = 有订阅者被停机打断了，是一次真实的事故信号，不能静默）。
   * @limitation **只等已经发出的事件**，不阻止新事件：drain 期间若还有请求在 publish，
   *      新订阅者同样会被计入——这是"尽力而为"，不是屏障。
   *      与之配套的是停机顺序：先摘流量（{@link EventBus.publish} 不再被新请求调用）
   *      再 drain（main.ts 的 `beforeDrain` → 排空 → `afterDrain`）。
   */
  drain(timeoutMs: number): Promise<number>;
}
