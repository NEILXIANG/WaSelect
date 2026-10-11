/**
 * 职责：买家「我的」四个订单入口角标的**计数口径**——服务端 `GET /orders/counts` 与小程序页签定义的单一来源（S-7，AJ-481）。
 *
 * @why 角标原先由小程序取全量订单在本地数（utils/order-tabs.js `orderTabCounts`）。买家订单列表改为分页后，
 *      本地只拿得到第一页，数不全了——计数必须搬到服务端，而"哪些状态算进哪个入口"要两端同一份。
 * @why 每个入口只数**还在进行中**的状态：已送达 / 已退款是结果不是待办，算进去角标永远不归零。
 *      「售后·退款」另数"有进行中售后申请（AFTER_SALE_OPEN_STATUSES）"的单，同一张单两样都占只算一次。
 * @limitation 小程序进不了 shared，镜像在 miniprogram/utils/order-tabs.js `BADGE_STATUSES`，由单测逐键比对。
 */

/** 入口 → 计入的订单状态（全部是 OrderStatus 里的值）。 */
export const ORDER_BADGE_STATUSES = {
  unpaid: ['created', 'pending_payment'],
  to_ship: ['paid'],
  shipped: ['shipped'],
  after_sale: ['refunding'],
} as const satisfies Record<string, readonly string[]>;

export type OrderBadgeKey = keyof typeof ORDER_BADGE_STATUSES;
