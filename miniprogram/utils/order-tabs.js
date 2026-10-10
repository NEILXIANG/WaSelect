/**
 * 职责：买家订单**页签**的唯一真源（M-10，AJ-408）——页签 ↔ 状态集合、查询参数、「我的」四入口角标。
 *
 * @why 页签按**买家关心的阶段**分组而不是十态各一个（同管理端 AJ-400 的思路，视角不同）：
 *      买家问的是"有没有要付的""买到了没""发了没""退款怎样了"。一个页签对应几个状态，
 *      服务端 `GET /orders?status=a,b` 一次取齐（契约 0.6.49，与管理端同一个 shared 解析函数）。
 * @why 文案出处（不凭记忆）：
 *      「待付款」= `BUYER_STATUS.created.title`（utils/order-status.js）；
 *      「采购中」取自 `BUYER_STATUS.paid.title`「已付款 · 日本采购中」——代购模式下"已付款"的买家视角就是在采购（M-06 / AJ-405）；
 *      「已发货」= `BUYER_STATUS.shipped.title` 的前半；
 *      「售后·退款」与管理端页签同名（admin-web/src/orders/list-filter.ts STATUS_TABS，AJ-400）。
 * @why 已送达（delivered）归「已发货」：状态机里 delivered 仍可退款、仍会迁到 completed
 *      （server/src/domain/order.ts ORDER_TRANSITIONS），属于"还在路上收尾"；管理端「已发货」页签同样含它。
 * @why completed / cancelled / expired **只在「全部」**（ALL_ONLY_STATUSES，显式登记）：
 *      都是终态（shared TERMINAL_ORDER_STATUS），买家没有要做的事；为它们开页签只会把五格挤成七格。
 *      显式登记而不是"没分到就算全部"：单测据此断言契约 10 态"恰好一处"，服务端新增状态时立刻红。
 * @limitation 一：小程序不能 import `@waselect/shared`（无构建步骤），状态名是手写副本；
 *              单测从 shared 取 ORDER_STATUS 做全覆盖比对，漂移会红。
 * @limitation 二：角标只数**进行中**的单（BADGE_STATUSES），与页签内容不完全相同（页签还含已送达 / 已退款）——
 *              见 BADGE_STATUSES 的 @why。
 * @see ./order-status.js；../pages/order/index.vm.js；../pages/user/index.vm.js；docs/自主决策记录.md AJ-408
 */

/** 页签（顺序即展示顺序）。`statuses` 空数组 = 不过滤（「全部」）。 */
export const ORDER_TABS = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'unpaid', label: '待付款', statuses: ['created', 'pending_payment'] },
  { key: 'to_ship', label: '采购中', statuses: ['paid'] },
  { key: 'shipped', label: '已发货', statuses: ['shipped', 'delivered'] },
  // AJ-430：withAfterSale = 另收「有售后申请」的单（状态可能仍是已送达 / 已完成），取全量后由 tabItems 本地过滤
  {
    key: 'after_sale',
    label: '售后·退款',
    statuses: ['refunding', 'refunded'],
    withAfterSale: true,
  },
];

/** 只在「全部」里出现的状态（终态、买家无事可做；@see 文件头 @why）。 */
export const ALL_ONLY_STATUSES = ['completed', 'cancelled', 'expired'];

/**
 * 「我的」四入口角标：每个入口只数**还在进行中**的状态。
 * @why 已送达 / 已退款是结果不是待办：算进去的话角标永远不归零（每张历史单都占一个数），
 *      角标就失去"有事要看"的意思。每一项都是对应页签状态的子集（单测断言）。
 */
export const BADGE_STATUSES = {
  unpaid: ['created', 'pending_payment'],
  to_ship: ['paid'],
  shipped: ['shipped'],
  after_sale: ['refunding'],
};

const DEFAULT_TAB = 'all';

/**
 * 任意输入 → 合法的页签 key（认不出 → 「全部」）。
 * @why 用 `find` 而不是对象下标：`'constructor'` 这类原型键不能被当成一个页签。
 */
export function resolveOrderTab(key) {
  if (typeof key !== 'string') return DEFAULT_TAB;
  return ORDER_TABS.some((t) => t.key === key) ? key : DEFAULT_TAB;
}

/**
 * 页签 → `status` 查询参数值（「全部」= 空串：调用方不带这个参数）。
 * @why 「售后·退款」也返回空串（AJ-430）：它要「状态是退款中 / 已退款 **或** 有售后申请」，服务端 status 过滤表达不了「或」；
 *      `GET /orders` 本就不分页、一次取全，取全量后用 {@link tabItems} 在本地过滤，不为此改服务端查询语义。
 * @limitation 买家订单很多时这一页签多取了无关的单（列表本就全量返回，量级同「全部」页签）。
 */
export function tabStatusParam(key) {
  const tab = ORDER_TABS.find((t) => t.key === resolveOrderTab(key));
  return tab === undefined || tab.withAfterSale === true ? '' : tab.statuses.join(',');
}

/** 列表行是否带售后申请（契约 0.6.60 `after_sale_state`：open / closed）。 */
function hasAfterSale(o) {
  const s = o !== null && typeof o === 'object' ? o.after_sale_state : undefined;
  return s === 'open' || s === 'closed';
}

/**
 * 某页签实际要显示的行（AJ-430）。带 `withAfterSale` 的页签：状态命中 **或** 有售后申请（进行中或已结案——买家要回来看结果）；
 * 其它页签服务端已按 status 过滤，原样返回。
 * @param {string} key 页签 key
 * @param {unknown} items 契约 `OrderListItem[]`
 */
export function tabItems(key, items) {
  if (!Array.isArray(items)) return [];
  const tab = ORDER_TABS.find((t) => t.key === resolveOrderTab(key));
  if (tab === undefined || tab.withAfterSale !== true) return items;
  return items.filter((o) => {
    const status = o !== null && typeof o === 'object' ? o.status : undefined;
    return tab.statuses.includes(status) || hasAfterSale(o);
  });
}

/**
 * `GET /orders` 的 items → 四个入口的进行中单数。
 * @param {unknown} items 契约 `OrderListItem[]`
 * @returns {{unpaid: number, to_ship: number, shipped: number, after_sale: number}}
 */
export function orderTabCounts(items) {
  const counts = { unpaid: 0, to_ship: 0, shipped: 0, after_sale: 0 };
  if (!Array.isArray(items)) return counts;
  for (const o of items) {
    const status = o !== null && typeof o === 'object' ? o.status : undefined;
    for (const key of Object.keys(BADGE_STATUSES)) {
      // AJ-430：「售后·退款」另数「有进行中的售后申请」的单；同一张单两样都占只算一次（|| 短路）
      const openAfterSale =
        key === 'after_sale' &&
        o !== null &&
        typeof o === 'object' &&
        o.after_sale_state === 'open';
      if (BADGE_STATUSES[key].includes(status) || openAfterSale) counts[key] += 1;
    }
  }
  return counts;
}

/** 角标文案：0 / 脏值不显示；超过 99 显示 `99+`（同购物车角标 `cartBadgeText` 口径）。 */
export function tabBadgeText(n) {
  if (!Number.isInteger(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}
