/**
 * 职责：买家订单**页签**的唯一真源（M-10，AJ-408）——页签 ↔ 状态集合、列表查询串（S-7 起分页）、角标文案。
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
 * @limitation 二：「我的」角标的**计数**由服务端 `GET /orders/counts` 给（S-7，口径 shared `ORDER_BADGE_STATUSES`）：
 *              列表分页后本地只拿得到第一页，数不全。这里只留角标文案（tabBadgeText）。
 * @see ./order-status.js；../pages/order/index.vm.js；../pages/user/index.vm.js；docs/自主决策记录.md AJ-408
 */

/** 页签（顺序即展示顺序）。`statuses` 空数组 = 不过滤（「全部」）。 */
export const ORDER_TABS = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'unpaid', label: '待付款', statuses: ['created', 'pending_payment'] },
  { key: 'to_ship', label: '采购中', statuses: ['paid'] },
  { key: 'shipped', label: '已发货', statuses: ['shipped', 'delivered'] },
  // AJ-430：withAfterSale = 另收「有售后申请」的单（状态可能仍是已送达 / 已完成）；S-7 起由服务端 include_after_sale=1 筛
  {
    key: 'after_sale',
    label: '售后·退款',
    statuses: ['refunding', 'refunded'],
    withAfterSale: true,
  },
];

/** 只在「全部」里出现的状态（终态、买家无事可做；@see 文件头 @why）。 */
export const ALL_ONLY_STATUSES = ['completed', 'cancelled', 'expired'];

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
 * @why S-7（契约 0.6.69）起「售后·退款」也带自己的状态：「或有售后申请」由 `include_after_sale=1` 交给服务端
 *      （原先返回空串、取全量后本地滤——列表一分页，本地就只能滤第一页了）。
 */
export function tabStatusParam(key) {
  const tab = ORDER_TABS.find((t) => t.key === resolveOrderTab(key));
  return tab === undefined ? '' : tab.statuses.join(',');
}

/** 买家订单列表每页条数（S-7；服务端上限 50，与商品列表默认同为 20）。 */
export const ORDER_PAGE_SIZE = 20;

/**
 * 页签 + 页码 → `GET /orders` 的查询串（S-7，契约 0.6.69）。
 * @param {unknown} key 页签 key（认不出 → 全部）
 * @param {unknown} page 页码（脏值 → 1）
 * @returns {string} 以 `?` 开头
 */
export function orderListQuery(key, page) {
  const tabKey = resolveOrderTab(key);
  const tab = ORDER_TABS.find((t) => t.key === tabKey);
  const status = tabStatusParam(tabKey);
  const p = Number.isInteger(page) && page >= 1 ? page : 1;
  const parts = [];
  if (status !== '') parts.push(`status=${status}`);
  if (tab?.withAfterSale === true) parts.push('include_after_sale=1');
  parts.push(`page=${String(p)}`, `size=${String(ORDER_PAGE_SIZE)}`);
  return `?${parts.join('&')}`;
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

/** 角标文案：0 / 脏值不显示；超过 99 显示 `99+`（同购物车角标 `cartBadgeText` 口径）。 */
export function tabBadgeText(n) {
  if (!Number.isInteger(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}
