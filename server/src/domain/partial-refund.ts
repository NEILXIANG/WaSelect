/**
 * 职责：部分退款（含订单完成后的售后退款）的**准入判定**与整单退款的**余额**计算（AJ-383）。纯函数，无 IO。
 *
 * @why 部分退款不走状态机（订单状态不变，退款记在 `order_refunds`，迁移 030），
 *      所以"能不能再退、最多退多少"不能借 `ORDER_TRANSITIONS` 回答，要有自己的唯一判定处。
 * @why 金额一律是**支付币种的最小单位**（与 payments.charge_amount 同口径），不经 JPY 折算——见迁移 030 的 @why。
 * @why 一次只允许一笔在途（initiated / pending / unknown）：并发两笔时，"额度够不够"要在两边都结果不明的情况下判断，
 *      而在途那笔可能已经退出去了。串行化之后，求和口径只有一个。
 * @tradeoff 代价：运营要等上一笔落定才能发下一笔。部分退款是低频人工操作，等待可接受。
 * @limitation 只判定"这一笔能不能发起"，不判定"退完要不要动库存"——部分退款不回补库存（退货入库属人工流程）。
 *
 * @see migrations/030_order_refunds.sql；app/partial-refund-routes.ts；domain/admin-order-actions.ts（整单退款闸门）
 */
import type { OrderStatus } from '@waselect/shared';
import type { AdminGateResult } from './admin-order-actions.js';

/** 收到了钱、且整单退款没在走的状态。completed 在内：这正是"完成后售后退款"的出口。 */
const PARTIAL_REFUNDABLE: readonly OrderStatus[] = ['paid', 'shipped', 'delivered', 'completed'];

export interface PartialRefundInput {
  status: OrderStatus;
  hasDispute: boolean;
  /** 实收（payments.charge_amount，最小单位）。 */
  chargeAmountMinor: number;
  /** 已占额度：本单除 failed 外全部部分退款之和（在途的可能已经退出去了，也要算）。 */
  reservedMinor: number;
  /** 是否已有一笔在途（initiated / pending / unknown）。 */
  inFlight: boolean;
  /** 本次要退的金额（最小单位）。 */
  amountMinor: number;
  /**
   * 通道能力声明 `supportsPartialRefund`（第三轮缺口 P2-4，AJ-385）。
   * @why 原先所有通道都声明 false、却没有人读它——部分退款照样发出去；下一个真不支持部分退款的通道不会被拦。
   */
  channelSupportsPartial: boolean;
  /**
   * 这笔付款上**已败诉**的拒付金额（payments.dispute_amount，同币种最小单位；没有为 0）——AJ-516。
   * @why 败诉 = 这部分钱已被银行退回买家。人工解除拒付限制（has_dispute → false）后，
   *      额度若仍按实收算，运营就能把银行已退的钱再退一次。只扣败诉的那部分，不一律拦：
   *      拒付可以只针对部分金额（docs.stripe.com/disputes/how-disputes-work「Partial disputes」），其余部分仍可能要退。
   */
  lostDisputeMinor: number;
}

/**
 * 判定顺序：状态 → 拒付 → 在途 → 金额形状 → 额度。
 * @why 状态在最前：整单已退 / 没收到钱时，金额填得对不对没有意义，先报金额会误导运营去改数字。
 */
export function partialRefundGuard(i: PartialRefundInput): AdminGateResult {
  if (!PARTIAL_REFUNDABLE.includes(i.status)) {
    return { ok: false, code: 40902, reason: `status_${i.status}` };
  }
  if (i.hasDispute) return { ok: false, code: 40907, reason: 'dispute_open' };
  if (!i.channelSupportsPartial) {
    return { ok: false, code: 40902, reason: 'partial_refund_not_supported' };
  }
  if (i.inFlight) return { ok: false, code: 40902, reason: 'partial_refund_in_flight' };
  if (!Number.isInteger(i.amountMinor) || i.amountMinor < 1) {
    return { ok: false, code: 40001, reason: 'amount_invalid' };
  }
  if (i.reservedMinor + i.lostDisputeMinor + i.amountMinor > i.chargeAmountMinor) {
    return { ok: false, code: 40001, reason: 'exceeds_refundable' };
  }
  return { ok: true };
}

/**
 * 整单退款在**拒付已败诉**时的闸门（AJ-516）：有败诉金额就拒（40907 dispute_lost），refunding 重试放行。
 *
 * @why 整单退款退的是余额（含银行已退回买家的那部分）：机构若照退 = 买家拿两次钱；机构若拒
 *      （对拒付过的付款退款，Stripe 文档列有 charge_disputed）= 订单停在 refunding、要人工收拾（AJ-514 的坑）。
 *      两条路都错，所以整单退款一律拒；要退未被拒付的其余部分，走部分退款——失败只是一笔记为失败、订单状态不动。
 * @why refunding 放行：与 refundGuard 的 OPS3-03 同口径——那是同一把幂等键的重试，钱只可能动一次。
 * @limitation 只看本系统记下的 dispute_status = lost；机构没发结案事件（漏发）时这里不知道，仍靠 has_dispute 那一道。
 * @limitation 败诉后 Stripe 是否接受对其余部分退款**未实测**（本地没有 Stripe 测试账号）：
 *      部分退款路径照常发起，若机构拒绝，那笔记为失败、额度释放，运营可见。
 */
export function fullRefundDisputeLostGuard(
  status: OrderStatus,
  lostDisputeMinor: number,
): AdminGateResult {
  if (status === 'refunding') return { ok: true };
  if (lostDisputeMinor > 0) return { ok: false, code: 40907, reason: 'dispute_lost' };
  return { ok: true };
}

/**
 * 整单退款要退的**余额** = 实收 − 已成功的部分退款；不足 0 按 0（调用方据此拒绝）。
 * @why 先部分退过的单，再按实收全额去退，机构会以"超出可退金额"拒绝——订单就卡死在 refunding。
 */
export function fullRefundAmount(chargeAmountMinor: number, succeededPartialMinor: number): number {
  return Math.max(0, chargeAmountMinor - succeededPartialMinor);
}
