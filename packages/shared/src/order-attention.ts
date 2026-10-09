/**
 * 职责：管理端订单列表的"待处理"筛选（`GET /admin/orders?attention=`，AJ-425，契约 0.6.58）——三类"有人负责却没人看得到"的单。
 *
 * - `after_sale`：有进行中的售后申请（open / processing）；
 * - `late_paid`：关单后才到账、钱已扣，尚未退款（不含退款中 / 已退款）；
 * - `blocked`：下单人已被拉黑、订单已付款未发货（拉黑只连带取消在途单，已付单由运营判断退款还是照发——block-user.ts @limitation 一）。
 *
 * @why 三端共用一份取值：服务端白名单、管理端待办格与筛选提示都从这里取，避免"后台多一类、前端没跟上"。
 * @see server/src/adapters/orders-admin.ts（筛选 SQL）；admin-web/src/orders/TodoBar.tsx
 */
export const ORDER_ATTENTIONS = ['after_sale', 'late_paid', 'blocked'] as const;
export type OrderAttention = (typeof ORDER_ATTENTIONS)[number];

export const ORDER_ATTENTION_LABELS: Readonly<Record<OrderAttention, string>> = {
  after_sale: '售后待处理',
  late_paid: '迟到付款待退',
  blocked: '拉黑用户的已付单',
};

export function isOrderAttention(v: unknown): v is OrderAttention {
  return typeof v === 'string' && (ORDER_ATTENTIONS as readonly string[]).includes(v);
}
