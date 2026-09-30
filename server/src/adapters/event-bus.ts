/**
 * 职责：领域事件总线的**进程内实现**（F10 后半，R2-2）——同步分发 + 失败隔离。
 *
 * @why 用 `Map<string, Set<handler>>` 而不是数组：事件名是高频查找键，
 *      数组每发布一次就要全量扫一遍订阅者（订阅者多了以后，发布成本随订阅数线性增长）。
 *      Set 顺带解决"同一个 handler 重复订阅"的问题——重复注册会静默地执行两次，
 *      这类 bug 的表现是"邮件发了两封"，很难从日志反推。
 *
 * @limitation 一：**进程内、内存态**——进程重启后订阅关系要重新注册，
 *              已提交但还没分发完的事件会丢（见 ../ports/events.ts @limitation 二）。
 * @limitation 二：订阅者**可以 async**，但总线**发后不等**（fire-and-forget）：
 *              `publish` 返回时 async 订阅者可能还在跑。
 *              ⚠️ 这不只是"失败收不到"的问题——**停机时它会直接被打断**：
 *              停机流若先 `closeDb`，在途订阅者拿到的是"连接池已关闭"。
 *              所以总线维护在途集合并提供 {@link EventBus.drain}（B13 / AJ-202），
 *              停机流必须在关资源**之前**调一次。
 * @limitation 三：不做通配符订阅（`order.*`）。MVP 事件名个位数，
 *              加通配符就要引入匹配优先级与"谁先谁后"的语义，收益不抵复杂度；
 *              真需要"订阅所有事件"（比如统一埋点），显式对每个名字注册同一个 handler 即可。
 *
 * @tradeoff 不做**异步分发**（`await Promise.allSettled`）：换来"发布方绝不被订阅者拖慢/拖挂"
 *           的确定性，以及"发布返回时订阅者已跑完"这个好测的语义。
 *           代价见 @limitation 二——异步副作用必须订阅者自己兜。
 *
 * @upgrade **outbox 升级路径**（现在不做，写在这里是为了别把简化版当成终态）：
 *          ① 事务内把事件插进 `outbox_events`（与业务写同事务，崩溃不丢）；
 *          ② 提交后由独立的投递 worker 轮询 outbox 并投递，失败按退避重试；
 *          ③ 订阅者允许异步、允许跨进程。
 *          🔴 **升级的触发条件已经满足（B13 / AJ-202，2026-09-30 更正）**：
 *          `app/close-session-events.ts` 就是"事件丢了会造成资金事故"的订阅者——
 *          它负责作废机构侧会话，被中断 ⇒ 已取消/已过期的单还能被付款
 *          （会话自然过期前最长约 30 分钟）。
 *          本轮先做**缓解**（`drain` + 停机前等待），**不等于债务清零**：
 *          drain 只覆盖"优雅停机"，覆盖不了 SIGKILL / OOM / 崩溃——那些情形事件照样丢。
 *          欠账条目已登记（docs 侧），真正清零仍要 outbox。
 *          （v1.2 附录 #15 已裁定 outbox 降级——本注释就是那条裁定的落点。）
 *
 * @see ../ports/events.ts（契约与全部设计理由）；docs/地基搭建清单.md F10
 */
import type { DomainEvent, EventBus, EventHandler } from '../ports/events.js';
import type { Logger } from '../logger.js';

/** 订阅者失败时的日志事件名——可检索、可告警，别改成拼字符串。 */
const SUBSCRIBER_FAILED = 'domain_event_subscriber_failed';

/**
 * 造一个进程内事件总线。
 *
 * @param logger **必填**：订阅者失败必须落 error（静默吞掉 = 订阅者悄悄失效几个月没人知道）。
 *               必填而不是可选，是为了让"装配时必须回答一次拿什么记日志"变成强制力。
 */
export function createEventBus(logger: Logger): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  /**
   * 在途的 async 订阅者（B13 / AJ-202）。
   * @why "谁还在跑"这个事实**只有总线知道**：订阅者的 Promise 不发出来，
   *      调用方（停机流）想等也无从下手。这是 {@link EventBus.drain} 的唯一依据。
   * @limitation 只登记 **async** 订阅者。同步订阅者在 `publish` 返回前就跑完了，
   *             记进集合只会让 drain 永远等一个已经结束的东西。
   */
  const inflight = new Set<Promise<unknown>>();

  const forName = (name: string): Set<EventHandler> => {
    const existing = handlers.get(name);
    if (existing !== undefined) return existing;
    const created = new Set<EventHandler>();
    handlers.set(name, created);
    return created;
  };

  const logFailed = (event: DomainEvent, e: unknown): void => {
    // 关键：单个订阅者失败只记日志，不冒泡、不中断其余订阅者。
    // ⚠️ 领域事件名不能写成 `event:`——logger 会把调用点的 `event` 键**静默丢弃**
    //    （logger.ts 的 SILENT_DROP_KEYS，缺陷 #6 确立的行为），写进去等于没写。
    //    所以放进 ctx，检索时用 `domain_event = order.created` 找。
    logger.error(SUBSCRIBER_FAILED, {
      order_id: event.orderId,
      result: 'subscriber_threw',
      err: e instanceof Error ? e.message : String(e),
      ctx: { domain_event: event.name, at: event.at },
    });
  };

  const dispatchOne = (event: DomainEvent, handler: EventHandler): void => {
    try {
      const r: unknown = handler(event);
      // 三审 P2-1：async 订阅者的 rejection 不走 try/catch——不接住就逃到进程级
      //    unhandledRejection（N25 → fatal + 停机）。这里"发后不等"：publish 仍是同步语义，
      //    只是把 rejection 收敛成同一条 subscriber_failed 日志。
      if (r instanceof Promise) {
        // ⚠️ 登记必须在 `.catch()` **之前**用同一个 Promise 链：先接住失败（不让它逃出去），
        //    再把"接住之后的那个 Promise"登记为在途——否则 drain 等的是原始 Promise，
        //    它 reject 的那一路已经没人处理了。
        const tracked = r.catch((e: unknown) => logFailed(event, e));
        inflight.add(tracked);
        // 跑完（成功或已记日志的失败）就移出在途集合——**失败也算跑完**：
        // drain 的语义是"这次分发的后果已经尘埃落定"，不是"都成功了"。
        // 用 finally 而不是 then：reject 分支已被上面的 catch 消化，但万一还有别的抛出，
        // 也不能让一个永远不 settle 的 Promise 把停机挂死。
        void tracked.finally(() => inflight.delete(tracked));
      }
    } catch (e) {
      logFailed(event, e);
    }
  };

  // ⚠️ 用局部函数而不是 `this.publish`：`publishAll` 一旦被解构出去
  //    （`const { publishAll } = bus`——测试与装配处都可能这么写），`this` 就丢了。
  //    这种失败只在"单独拿出去用"时才出现，本地跑永远正常，属于最难查的一类。
  const publish = (event: DomainEvent): void => {
    // 拷贝一份再遍历：订阅者里再订阅/退订是合法的，边遍历边改 Set 会漏发或重发
    const set = handlers.get(event.name);
    if (set === undefined) return;
    for (const handler of [...set]) dispatchOne(event, handler);
  };

  const subscribe = (name: string, handler: EventHandler): (() => void) => {
    const set = forName(name);
    set.add(handler);
    let active = true;
    return () => {
      if (!active) return; // 幂等：重复退订不该把别人注册的同一 handler 删掉两次
      active = false;
      set.delete(handler);
    };
  };

  /**
   * 等在途的 async 订阅者跑完（契约见 ../ports/events.ts）。
   *
   * @why **循环**而不是"等一次 `Promise.allSettled` 就完事"：等的过程中可能又有新事件进来
   *      （drain 期间仍有请求在 publish），一次性等待会漏掉这一批。
   *      循环到集合为空，才是"此刻真的没有了"。
   * @why 超时用 `Promise.race` 而不是给每个订阅者加超时：订阅者自己不知道停机这回事，
   *      把"最多等多久"塞进它们会污染业务语义（它们只是普通的 async 函数）。
   * @limitation 定时器**必须 clearTimeout**：否则即使订阅者早早跑完，
   *              这个挂着的 timer 也会把进程多留一个 `timeoutMs`（停机流最不需要的就是拖时间）。
   * @tradeoff drain 期间进程仍在处理：这是"给在途订阅者一个善终"的代价，
   *           由停机预算（SHUTDOWN_EVENT_DRAIN_MS）封顶，不会无限延后。
   */
  const drain = async (timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (inflight.size === 0) return 0;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return inflight.size;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };

  return {
    subscribe,
    publish,
    publishAll: (events) => {
      for (const event of events) publish(event);
    },
    drain,
  };
}
