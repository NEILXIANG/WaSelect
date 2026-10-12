/**
 * 职责：订单状态 → 后台（运营）看的中文（AJ-494：由 admin-web 挪到 shared，后台页面与服务端导出共用）。
 *
 * @why 订单总表导出原写 `paid` / `shipped` 这类代号，运营在 Excel 里读不懂；导出与页面用同一份词，
 *      页面上看到"待发货"、表里也是"待发货"，不会出现两套说法。
 * @why 与小程序的买家词表（miniprogram/utils/order-status.js）刻意不同：这是运营视角（paid = 待发货、delivered = 已签收）。
 * @limitation 只给后台 / 导出用；买家看的文案在小程序那一份。
 */
import type { OrderStatus } from './enums.js';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  // AJ-410 / N15：白话（原「待付款（未发起）/（支付中）」）；列表、详情、时间线、导出都只读这一处
  created: '已下单，等待买家付款',
  pending_payment: '买家正在付款',
  paid: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  completed: '已完成',
  cancelled: '已取消',
  // 与买家端「已超时关闭」同一件事同一说法；原「已过期」运营要想一下是什么过期了（业务旅程测试 2026-10-12）
  expired: '超时关闭',
  refunding: '退款中',
  refunded: '已退款',
};
