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
  if (i.reservedMinor + i.amountMinor > i.chargeAmountMinor) {
    return { ok: false, code: 40001, reason: 'exceeds_refundable' };
  }
  return { ok: true };
}

/**
 * 整单退款要退的**余额** = 实收 − 已成功的部分退款；不足 0 按 0（调用方据此拒绝）。
 * @why 先部分退过的单，再按实收全额去退，机构会以"超出可退金额"拒绝——订单就卡死在 refunding。
 */
export function fullRefundAmount(chargeAmountMinor: number, succeededPartialMinor: number): number {
  return Math.max(0, chargeAmountMinor - succeededPartialMinor);
}
