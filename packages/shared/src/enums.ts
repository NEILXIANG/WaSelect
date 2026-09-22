/**
 * 职责：跨端枚举与常量（订单状态 / 支付通道 / 币种 / 国家 / 前端展示映射）。
 * 边界：只放常量与纯映射，不含状态迁移规则（那是业务，属 F10 通用执行器之上的具体规则）。
 * @see 技术文档 v0.5 §1（状态机，10 态）、§2（通道）、ADR-09（JPY 唯一锚）
 * @limitation 状态"能迁到哪"不在这里——`ALLOWED_TRANSITIONS` 属于业务第一批，地基只保证枚举与展示映射齐全。
 */

/** 订单状态（10 态，与技术文档 §1 逐字一致）。 */
export const ORDER_STATUS = [
  'created',
  'pending_payment',
  'paid',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'expired',
  'refunding',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** 支付通道（注册表里的可用实现；`mock` 仅供审核期与测试）。 */
export const PAYMENT_CHANNEL = ['mock', 'wechat', 'stripe'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNEL)[number];

/** 币种：JPY 是唯一定价锚与记账币；其余只作展示与扣款。 */
export const CURRENCY = ['JPY', 'CNY', 'USD'] as const;
export type Currency = (typeof CURRENCY)[number];

/** MVP 只发美国（ADR-28：`country_profiles` 将来扩展）。 */
export const COUNTRY = ['JP', 'US'] as const;
export type Country = (typeof COUNTRY)[number];

/**
 * 前端订单展示分组（技术文档 §1 末尾的映射）。
 * @tradeoff 放在 shared 而非前端：管理后台与小程序要显示同一套标签，避免两处文案漂移。
 */
export const ORDER_STATUS_DISPLAY: Readonly<Record<OrderStatus, string>> = {
  created: '待付款',
  pending_payment: '待付款',
  paid: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  completed: '已签收',
  cancelled: '已关闭',
  expired: '已关闭',
  refunding: '退款中',
  refunded: '已退款',
};
