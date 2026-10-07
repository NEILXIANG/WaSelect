/**
 * 职责：订单通知邮件订阅者（剩余清单 2-2 / D-41 邮件兜底）——付款成功、已发货、部分退款（每笔一封，P2-12）、已退款各发一封给 `contact_email`。
 *
 * @why 订阅事件而不是在路由里发信：发信是"事务提交之后的副作用"，总线保证只有提交成功才分发；
 *      写在路由里要么在事务内（回滚了信已发出），要么每条路由各写一份。
 * @why 发送失败**吞掉**并记 error（`order_mail_failed`），不抛给总线：总线对抛错的订阅者只记
 *      `domain_event_subscriber_failed`，丢了"是哪类信、哪张单"的上下文；这里自己记得更准。
 * @why 幂等键 `事件:订单`：进程重启 / 事件被重放时服务商侧去重，不会给买家发两封。
 * @limitation 一：没有重试队列（端口 @limitation 二）。失败只能从日志里捞出来人工处理。
 * @limitation 二：没留邮箱的单只记 `order_mail_skipped`——小程序内的订阅消息（D-41③）等 AppID 后接。
 * @limitation 三：日志里只有 order_id 与 tag，没有邮箱（约束七）。
 * @see ports/mailer.ts；app/mail-templates.ts；app/business-events.ts（同一总线上的日志订阅者）
 */
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../ports/events.js';
import type { Mailer } from '../ports/mailer.js';
import { MAIL_TEMPLATES } from './mail-templates.js';

/** 会发邮件的事件（顺序即登记顺序）。 */
export const MAIL_EVENTS = [
  'order.paid',
  'order.shipped',
  'order.partially_refunded',
  'order.refunded',
] as const;

export interface OrderMailDeps {
  db: Db;
  mailer: Mailer;
  logger: Logger;
}

async function notify(
  deps: OrderMailDeps,
  tag: string,
  orderId: string,
  /** 同一订单可能有多笔（部分退款）：带上它，服务商侧幂等键才不会把第二笔当成重放。 */
  subKey?: string,
): Promise<void> {
  const [o] = await deps.db`
    select order_no, contact_email, carrier, tracking_no from orders where id = ${orderId}`;
  const email = o?.['contact_email'];
  if (typeof email !== 'string' || email === '') {
    deps.logger.info('order_mail_skipped', {
      order_id: orderId,
      result: 'skipped',
      ctx: { tag, reason: 'no_email' },
    });
    return;
  }
  const content = MAIL_TEMPLATES[tag]?.({
    orderNo: String(o?.['order_no']),
    carrier: (o?.['carrier'] as string | null) ?? null,
    trackingNo: (o?.['tracking_no'] as string | null) ?? null,
  });
  if (content === undefined) return; // MAIL_EVENTS 与模板表由单测对齐，这里只防御
  try {
    const r = await deps.mailer.send({
      to: email,
      ...content,
      idempotencyKey: subKey === undefined ? `${tag}:${orderId}` : `${tag}:${orderId}:${subKey}`,
      tag,
    });
    deps.logger.info('order_mail_sent', { order_id: orderId, result: r.status, ctx: { tag } });
  } catch (e) {
    deps.logger.error('order_mail_failed', {
      order_id: orderId,
      result: 'failed',
      ctx: { tag, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

export function registerOrderMail(bus: EventBus, deps: OrderMailDeps): void {
  for (const name of MAIL_EVENTS) {
    bus.subscribe(name, (event) =>
      event.orderId === undefined
        ? undefined
        : notify(
            deps,
            name,
            event.orderId,
            typeof event.payload?.['refund_id'] === 'string'
              ? event.payload['refund_id']
              : undefined,
          ),
    );
  }
}
