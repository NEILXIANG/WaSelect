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
import { AFTER_SALE_OPEN_STATUSES, ORDER_STATUS, type OrderStatus } from '@waselect/shared';
import type { BadgeTone } from '../ui/badge.js';
import { DISPUTE_LOCK_TEXT, ORDER_STATUS_LABELS, disputeLockState } from './view.js';

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
  return [...out, ...flagBadges(detailFlags(order))];
}

/**
 * 详情形状 → `flagBadges` 认的两个布尔（三端联动模拟 2026-10-10）。
 * @why 详情接口（AdminOrder）不带列表行的 `user_blocked` / `after_sale_open`，同样的信息在 `customer.blocked`
 *      与 `after_sales` 里。只认列表字段时，详情页加载完这两枚徽章就消失——运营从「待发货」点进拉黑用户的单，
 *      页头只有"已付款 · 待发货"，照常发货。"进行中"取 shared 的 AFTER_SALE_OPEN_STATUSES（与服务端同源）。
 */
function detailFlags(order: unknown): unknown {
  if (order === null || typeof order !== 'object') return order;
  const o = order as {
    user_blocked?: unknown;
    after_sale_open?: unknown;
    customer?: { blocked?: unknown } | null;
    after_sales?: unknown;
  };
  const isOpen = (st: unknown): boolean =>
    (AFTER_SALE_OPEN_STATUSES as readonly unknown[]).includes(st);
  return {
    ...o,
    user_blocked: o.user_blocked === true || o.customer?.blocked === true,
    after_sale_open:
      o.after_sale_open === true ||
      (Array.isArray(o.after_sales) &&
        o.after_sales.some((a: { status?: unknown } | null) => isOpen(a?.status))),
  };
}

/**
 * 标记（列表与详情共用）：拒付中 = danger，测试单 = muted；
 * AJ-425：售后中 = warn（有人在等处理）、用户已拉黑 = danger（发货前要判断退款还是照发）。
 */
export function flagBadges(order: unknown): BadgeSpec[] {
  const o = order as {
    is_test?: unknown;
    after_sale_open?: unknown;
    user_blocked?: unknown;
    late_paid?: unknown;
    status?: unknown;
    ship_overdue?: unknown;
  } | null;
  // 三端模拟测试（2026-10-11）：关单后才到账的钱要退——原先列表与详情头只写"已过期"，要读到时间线最后一行才知道
  const latePaidPending =
    o?.late_paid === true && (o.status === 'expired' || o.status === 'cancelled');
  const dispute = disputeLockState(order);
  return [
    ...(dispute !== null
      ? [{ text: DISPUTE_LOCK_TEXT[dispute].badge, tone: 'danger' as const }]
      : []),
    ...(latePaidPending ? [{ text: '迟到付款待退', tone: 'danger' as const }] : []),
    // AJ-484：付款超过承诺的 N 个工作日仍未发货（服务端按 JST 工作日算好的 ship_overdue）
    ...(o?.ship_overdue === true ? [{ text: '超时未发货', tone: 'danger' as const }] : []),
    ...(o?.after_sale_open === true ? [{ text: '售后中', tone: 'warn' as const }] : []),
    ...(o?.user_blocked === true ? [{ text: '用户已拉黑', tone: 'danger' as const }] : []),
    ...(o?.is_test === true ? [{ text: '测试单', tone: 'muted' as const }] : []),
  ];
}
