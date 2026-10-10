/**
 * 职责：订单通知邮件订阅者（剩余清单 2-2 / D-41 邮件兜底）——付款成功、已发货、部分退款（每笔一封，P2-12）、已退款各发一封给 `contact_email`。
 *
 * @why 订阅事件而不是在路由里发信：发信是"事务提交之后的副作用"，总线保证只有提交成功才分发；
 *      写在路由里要么在事务内（回滚了信已发出），要么每条路由各写一份。
 * @why 发送失败**吞掉**并记 error（`order_mail_failed`），不抛给总线：总线对抛错的订阅者只记
 *      `domain_event_subscriber_failed`，丢了"是哪类信、哪张单"的上下文；这里自己记得更准。
 * @why 幂等键 `事件:订单`：进程重启 / 事件被重放时服务商侧去重，不会给买家发两封。
 * @limitation 一：没有重试**队列**（端口 @limitation 二）；每次结果落 `mail_deliveries`（E-1 / AJ-419），
 *              daily 补发（`mail-sweep.ts`）据此把"该发没发成"的重新发出——实时失败最晚次日补上。
 * @limitation 二：没留邮箱的单只记 `order_mail_skipped`——小程序内的订阅消息（D-41③）等 AppID 后接。
 * @limitation 三：日志里只有 order_id 与 tag，没有邮箱（约束七）。
 * @see ports/mailer.ts；app/mail-templates.ts；app/business-events.ts（同一总线上的日志订阅者）
 */
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../ports/events.js';
import type { Mailer } from '../ports/mailer.js';
import { MAIL_TEMPLATES } from './mail-templates.js';
import { maskText } from '../redact.js';

/** 会发邮件的事件（顺序即登记顺序）。 */
export const MAIL_EVENTS = [
  'order.paid',
  'order.shipped',
  // AJ-440：撤销发货后的更正信（买家已收到一封带运单号的发货邮件）
  'order.shipment_reverted',
  'order.partially_refunded',
  'order.refunded',
] as const;

export interface OrderMailDeps {
  db: Db;
  mailer: Mailer;
  logger: Logger;
}

type DeliveryStatus = 'sent' | 'failed' | 'skipped';

/**
 * 记一次发信结果（E-1 / AJ-419）。
 * @why 已经 sent 的不降级：补发与实时偶尔同时到（实时慢、补发快），后到的失败不能把"已送出"改回"失败"——
 *      否则下一轮 daily 又补一封。
 * @why 记录失败只记日志、**不抛**：发信已经发生了，记录写不进去不该反过来让订阅者报错（总线会把它记成订阅者失败）。
 * @why `last_error` 先过 `maskText`：服务商的报错常带收件人邮箱（"invalid recipient x@y"），约束七不许进库。
 */
async function record(
  deps: OrderMailDeps,
  key: string,
  orderId: string,
  tag: string,
  status: DeliveryStatus,
  error: string | null,
): Promise<void> {
  const lastError = error === null ? null : maskText(error).slice(0, 300);
  try {
    await deps.db`
      insert into mail_deliveries (idempotency_key, order_id, tag, status, last_error)
      values (${key}, ${orderId}, ${tag}, ${status}, ${lastError})
      on conflict (idempotency_key) do update set
        status = case when mail_deliveries.status = 'sent' then 'sent' else excluded.status end,
        last_error = case when mail_deliveries.status = 'sent' then null else excluded.last_error end,
        attempts = mail_deliveries.attempts + 1,
        last_at = now()`;
  } catch (e) {
    deps.logger.error('order_mail_record_failed', {
      order_id: orderId,
      result: 'failed',
      ctx: { tag, error: e instanceof Error ? e.message : String(e) },
    });
  }
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
  const key = subKey === undefined ? `${tag}:${orderId}` : `${tag}:${orderId}:${subKey}`;
  if (typeof email !== 'string' || email === '') {
    deps.logger.info('order_mail_skipped', {
      order_id: orderId,
      result: 'skipped',
      ctx: { tag, reason: 'no_email' },
    });
    // 订单不存在（o 为空）时没有可挂的外键行，不记
    if (o !== undefined) await record(deps, key, orderId, tag, 'skipped', null);
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
      idempotencyKey: key,
      tag,
    });
    deps.logger.info('order_mail_sent', { order_id: orderId, result: r.status, ctx: { tag } });
    // 服务商未配置（开发 / 审核期 log-only）记 skipped：补发不会去捞，也不会把"没配服务商"当成送达
    await record(deps, key, orderId, tag, r.status === 'sent' ? 'sent' : 'skipped', null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.logger.error('order_mail_failed', {
      order_id: orderId,
      result: 'failed',
      ctx: { tag, error: message },
    });
    await record(deps, key, orderId, tag, 'failed', message);
  }
}

/**
 * 同一订单同一事件可能发多封的区分键：部分退款按笔（`refund_id`），改运单号后重发发货邮件（`mail_key`，AJ-386），
 * 撤销发货的更正信与其后的再发货（`revert-<n>` / `reship-<n>`，AJ-440）。
 * 没有则 undefined（幂等键退回 `事件:订单`，与原口径一致）。
 */
function mailSubKey(payload: Record<string, unknown> | undefined): string | undefined {
  const k = payload?.['refund_id'] ?? payload?.['mail_key'];
  return typeof k === 'string' ? k : undefined;
}

export function registerOrderMail(bus: EventBus, deps: OrderMailDeps): void {
  for (const name of MAIL_EVENTS) {
    bus.subscribe(name, (event) =>
      event.orderId === undefined
        ? undefined
        : notify(deps, name, event.orderId, mailSubKey(event.payload)),
    );
  }
}
