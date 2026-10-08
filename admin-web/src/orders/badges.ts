/**
 * 职责：订单状态 → 徽章（文案 + 色调）的纯函数（AJ-400，对标 §4.2 / §5「状态徽章」）。
 *
 * @why 色调按**要不要人动手**分，不按状态本身分：待发货 / 退款中 = warn（今天要处理），
 *      已发货 / 已签收 = info（在路上，不用管），已完成 = success，已退 / 取消 / 过期 = muted（结束了），
 *      拒付 = danger。运营扫一眼列表看的是"黄的有几个"，不是去读每一格的字。
 * @why 详情页拆成**支付**与**履约**两枚（Shopify 同款）：一张"已发货"的单，客服常被问的是"钱扣了没"，
 *      合成一个"已发货"就要靠推理才知道"已付款"。只在有意义时出履约徽章：未付 / 退款 / 关闭的单没有履约可言。
 * @limitation 一：文案沿用 `ORDER_STATUS_LABELS`（管理端十态口径），履约徽章不另起词；
 *              部分退款不出徽章（订单状态不变，金额看支付区与部分退款列表）。
 * @limitation 二：认不出的状态 → neutral + "未知状态"（与 statusText 同口径），不抛。
 * @see ../ui/badge.tsx；./view.ts（ORDER_STATUS_LABELS / isDisputeLocked）
 */
import { ORDER_STATUS, type OrderStatus } from '@waselect/shared';
import type { BadgeTone } from '../ui/badge.js';
import { ORDER_STATUS_LABELS, isDisputeLocked } from './view.js';

export interface BadgeSpec {
  text: string;
  tone: BadgeTone;
}

const TONE: Readonly<Record<OrderStatus, BadgeTone>> = {
  created: 'neutral',
  pending_payment: 'neutral',
  paid: 'warn',
  shipped: 'info',
  delivered: 'info',
  completed: 'success',
  cancelled: 'muted',
  expired: 'muted',
  refunding: 'warn',
  refunded: 'muted',
};

function readStatus(order: unknown): OrderStatus | null {
  const s = (order as { status?: unknown } | null)?.status;
  return typeof s === 'string' && (ORDER_STATUS as readonly string[]).includes(s)
    ? (s as OrderStatus)
    : null;
}

/** 列表"状态"一格：一枚状态徽章。 */
export function statusBadge(order: unknown): BadgeSpec {
  const s = readStatus(order);
  return s === null
    ? { text: '未知状态', tone: 'neutral' }
    : { text: ORDER_STATUS_LABELS[s], tone: TONE[s] };
}

/** 支付侧（详情页头）。 */
function paymentBadge(s: OrderStatus): BadgeSpec {
  if (s === 'created' || s === 'pending_payment') return { text: '未付款', tone: 'neutral' };
  if (s === 'refunding' || s === 'refunded' || s === 'cancelled' || s === 'expired') {
    return { text: ORDER_STATUS_LABELS[s], tone: TONE[s] };
  }
  return { text: '已付款', tone: 'success' };
}

/** 详情页头的徽章组：支付 + （有意义时）履约 + 拒付 + 测试单。 */
export function detailBadges(order: unknown): BadgeSpec[] {
  const s = readStatus(order);
  const out: BadgeSpec[] = s === null ? [statusBadge(order)] : [paymentBadge(s)];
  if (s === 'paid' || s === 'shipped' || s === 'delivered' || s === 'completed') {
    out.push({ text: ORDER_STATUS_LABELS[s], tone: TONE[s] });
  }
  return [...out, ...flagBadges(order)];
}

/** 两个标记（列表与详情共用）：拒付中 = danger，测试单 = muted。 */
export function flagBadges(order: unknown): BadgeSpec[] {
  const o = order as { is_test?: unknown } | null;
  return [
    ...(isDisputeLocked(order) ? [{ text: '拒付中', tone: 'danger' as const }] : []),
    ...(o?.is_test === true ? [{ text: '测试单', tone: 'muted' as const }] : []),
  ];
}
