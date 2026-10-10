/**
 * 职责：业务事件的**首个订阅者**——把事件落成运行日志（装配处调用一次）。
 *
 * @why 总线不能"一个订阅者都没有"还挂在系统里：那等于一套没人用的机制，
 *      后来者会以为"emit 了就有人处理"，实际上什么都不会发生，而且**没有任何报错**——
 *      这是比"没做事件总线"更糟的状态（有机制、无效果、还以为有）。
 *      这个订阅者让"事件真的在流"变成日志里可查、e2e 里可断言的事实。
 *
 * @limitation 一：只记日志，**不做任何业务动作**。真正的订阅者（发券 / 通知 / 扣库存）
 *              随业务功能逐个加；每加一个都必须自带测试——
 *              订阅者的失败是**静默**的（只有一条 error 日志，请求照常成功），
 *              是最容易漏测的一类代码。
 * @limitation 二：事件名**在这里显式列举**，不用通配符订阅（总线不支持，见总线 @limitation 三）。
 *              代价：新增事件要记得来这里加一行——
 *              反过来这也是好处：新事件上线时会被迫回答"它要不要进日志"。
 *
 * @see ../ports/events.ts；../adapters/event-bus.ts
 */
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';

/**
 * 需要进日志的业务事件（新增事件时在这里登记）。
 *
 * ⚠️ 漏登记的后果是**静默**的：`emit` 出去没有任何订阅者，事件凭空消失，不报错、不告警，
 *    而 `mark-disputed.ts` 的注释还写着"事件会进日志"（OPS3-07 实测到的正是这个状态）。
 *    所以 `business-events.unit.test.ts` 有一条守卫：**扫源码里所有 emit 的事件名，
 *    断言它们都在这个列表里**。新增事件忘了来这里加一行 → 红灯。
 */
export const LOGGED_EVENTS: readonly string[] = [
  'order.created',
  'order.paid',
  'order.expired',
  'order.cancelled',
  // OPS3-07：拒付的开案 / 结案此前 emit 了却无人订阅，"拒付何时落库"只能从回调日志反推。
  // payload 只有 dispute_id / result，无 PII（@limitation 一：这里只记日志）。
  'order.dispute_opened',
  'order.dispute_closed',
  // 剩余清单 2-1：履约与退款事件（payload 只有承运商名，无 PII；运单号不进事件）
  'order.shipped',
  // AJ-440：撤销发货（payload 只有一次性邮件键）
  'order.shipment_reverted',
  'order.delivered',
  'order.refunded',
  // 第三轮缺口 P2-12：部分退款成功（payload 只有 refund_id）
  'order.partially_refunded',
  // 剩余清单 2-4：对账异常汇总（payload 只有各类计数）
  'reconciliation.anomalies_found',
];

/** 日志事件名——检索用；`domain_event` 放 ctx（写 `event:` 会被 logger 静默丢弃）。 */
export const BUSINESS_EVENT_LOG = 'business_event';

export function registerBusinessEventLog(bus: EventBus, logger: Logger): void {
  for (const name of LOGGED_EVENTS) {
    bus.subscribe(name, (event) => {
      logger.info(BUSINESS_EVENT_LOG, {
        order_id: event.orderId,
        result: 'dispatched',
        ctx: { domain_event: event.name, at: event.at, ...(event.payload ?? {}) },
      });
    });
  }
}
