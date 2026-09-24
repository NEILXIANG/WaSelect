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
 * @limitation 二：订阅者**同步**执行。订阅者内部若开异步任务，
 *              它的失败不在本总线的兜底范围内（总线已经返回了）。
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
 *          触发条件：**出现第一个"事件丢了会造成资金或履约事故"的订阅者**时立刻升级，
 *          不要等到事件种类变多才想起来。
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

  const forName = (name: string): Set<EventHandler> => {
    const existing = handlers.get(name);
    if (existing !== undefined) return existing;
    const created = new Set<EventHandler>();
    handlers.set(name, created);
    return created;
  };

  const dispatchOne = (event: DomainEvent, handler: EventHandler): void => {
    try {
      handler(event);
    } catch (e) {
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

  return {
    subscribe,
    publish,
    publishAll: (events) => {
      for (const event of events) publish(event);
    },
  };
}
