/**
 * 职责：**审核模式自动确认**（技术文档 §2.9 / AJ-179）——发起支付的事务提交后，若通道能自签确认报文，
 *       就把它送进与真实回调**同一条**管线。
 *
 * @why 不认通道名（约束四）：判据是端口能力 `selfConfirmation` 存不存在，而不是 `channel === 'mock'`。
 *      真实机构通道永远不实现它；mock 只在 REVIEW_MODE=on 时实现（adapters/payment/channels.ts）。
 * @why 在**提交之后**做：管线里的 mark-paid 要读到已提交的 payments 行；放在发起支付的事务里，
 *      回调管线看到的是"还没有这笔意图"（早到宽限分支），而且两段事务互相等锁。
 * @why 第二道防线"只确认测试单"：配置规则保证审核期只有 mock、审核期建的单都是 is_test——
 *      但"未付款即确认"是全系统最危险的动作，不能只靠配置组合成立；在动作发生处再核一次，
 *      万一哪天审核模式与真实订单并存（配置漂移、手工改库），确认会被拒而不是把真单置成已付。
 * @tradeoff 失败**不影响**发起支付的响应（只打 error 日志）：支付意图本身已经成功落库；
 *      让响应失败会诱导前端重试一次新的意图。代价：确认失败时小程序仍显示「支付已完成」，
 *      订单停在待付款——error 日志 + 用户同通道再点一次（复用意图 → 同一事件 id → 管线去重）可恢复。
 * @see 技术文档 v0.5 §2.9（审核模式）；docs/自主决策记录.md AJ-179 / AJ-30；app/pay-callback.ts（管线）
 */
import { isTestOrder } from '../adapters/orders.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { PaymentRegistry } from '../ports/payment.js';
import { handleProviderCallback, type CallbackPipelineDeps } from './pay-callback.js';

/** 刚提交的一笔支付意图（取自 createPayIntent 的返回）。 */
export interface CommittedIntent {
  orderId: string;
  channel: string;
  providerRef: string;
  charge: { currency: string; amount: number };
}

export type AutoConfirm = (intent: CommittedIntent) => Promise<void>;

export interface AutoConfirmDeps {
  db: Db;
  registry: PaymentRegistry;
  logger: Logger;
  /** 与 `/pay/callback/{channel}` 路由**同一份**管线依赖（mount.ts 只造一次，两处共用）。 */
  pipeline: CallbackPipelineDeps;
  /**
   * 本地模拟付款（MOCK_AUTO_CONFIRM=on 且 development / test）：第二道防线放行普通单。
   * @why 本地演练要走到发货 / 退款，而测试单不能发货；公网环境 config 跨字段 1e 拒绝这个开关，
   *      mount.ts 再按环境判一次——两道都在，因为这是"能把订单变成已付款"的门。
   */
  allowNonTestOrders?: boolean;
}

export function createAutoConfirm(deps: AutoConfirmDeps): AutoConfirm {
  return async (intent) => {
    const provider = deps.registry.getForCallback(intent.channel);
    const selfConfirm = provider.selfConfirmation;
    if (selfConfirm === undefined) return; // 真实通道：钱到没到只能由机构说
    const base = { order_id: intent.orderId, channel: intent.channel };
    try {
      if (
        deps.allowNonTestOrders !== true &&
        (await isTestOrder(deps.db, intent.orderId)) !== true
      ) {
        deps.logger.error('pay_auto_confirm_refused', { ...base, result: 'rejected' });
        return;
      }
      const msg = selfConfirm.call(provider, {
        orderId: intent.orderId,
        providerRef: intent.providerRef,
        amountMinor: intent.charge.amount,
        currency: intent.charge.currency,
      });
      const event = await provider.parseWebhook(msg.raw, msg.headers);
      const out = await handleProviderCallback(deps.pipeline, intent.channel, msg.raw, event);
      const fields = {
        ...base,
        result: out.disposition,
        ctx: { event_id: event.eventId, http_status: out.status },
      };
      if (out.status < 300) deps.logger.info('pay_auto_confirmed', fields);
      else deps.logger.error('pay_auto_confirm_failed', fields);
    } catch (e) {
      deps.logger.error('pay_auto_confirm_failed', { ...base, result: 'failed', err: e });
    }
  };
}
