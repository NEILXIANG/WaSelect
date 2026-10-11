/**
 * 职责：订单列表的**筛选纯函数**（AJ-400）——状态页签 ↔ URL `status`、日期预设 ↔ `created_from` / `created_to`。
 *
 * @why 页签按**运营的工作阶段**分组，而不是十态各一个：运营每天问的是"有几单要发货""有几单在售后"，
 *      不是"有几单 pending_payment"。一个页签对应几个状态（契约 0.6.44 起 `status` 可逗号分隔）：
 *      待付款 = created + pending_payment；已发货 = shipped + delivered；售后·退款 = refunding + refunded；
 *      另加「已关闭」= cancelled + expired——不加的话这两态只能从「全部」里翻，十态就不是全覆盖。
 * @why URL 仍以 `status=` 为唯一真源（不另造 `tab=`）：工作台的待办链接 `#/orders?status=paid`、
 *      已有收藏与"复制链接发同事"都依赖它。页签只是 URL 的一种**读法**：状态集合恰好等于某个页签 → 高亮它；
 *      是某个页签的一部分（如工作台的 `status=refunding`，只是售后页签的一半）→ 也高亮那个页签，
 *      页面另说"此页签下只显示：退款中"（AJ-410 / N27：原先什么都不高亮，新手以为点错了页面）；
 *      跨页签的自定义集合才不高亮任何页签。
 * @why 日期在 URL 里存**预设名**（`range=7d`），自定义才存具体日期：收藏的"近 7 天"明天打开仍是近 7 天，
 *      存死日期的话收藏就成了一段过去的时间。
 *
 * @limitation 一：日界按 JST（与工作台 `jstDayWindow` 同一函数），"今天"取的是调用方传入的 `now`——
 *              组件传 `new Date()`，所以跨过 JST 零点后要刷新才会滚到新的一天。
 * @limitation 二：URL 上认不出的 `status` / `range` 一律回落"全部"（AJ-398 同口径），不把坏值发给服务端换一个 40001。
 * @see ../../../packages/shared/src/order-list-filter.ts（服务端同一套校验）；./OrdersPage.tsx
 */
import {
  jstDate,
  jstDayWindow,
  parseJstDateRange,
  parseOrderStatusList,
  type OrderStatus,
} from '@waselect/shared';

export interface StatusTab {
  key: string;
  label: string;
  /** 空数组 = 不按状态过滤（「全部」）。 */
  statuses: readonly OrderStatus[];
}

export const STATUS_TABS: readonly StatusTab[] = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'unpaid', label: '待付款', statuses: ['created', 'pending_payment'] },
  { key: 'to_ship', label: '待发货', statuses: ['paid'] },
  { key: 'shipped', label: '已发货', statuses: ['shipped', 'delivered'] },
  { key: 'completed', label: '已完成', statuses: ['completed'] },
  { key: 'after_sale', label: '售后·退款', statuses: ['refunding', 'refunded'] },
  { key: 'closed', label: '已关闭', statuses: ['cancelled', 'expired'] },
];

/** 页签 → URL 的 `status` 值（「全部」= 空串，由页面删掉这个键）。 */
/**
 * 没有显式排序时各页签的默认排序（ADM-6 / AJ-453）：
 * 「待发货」按付款时间正序——最早付款、最久没发的在最前；其它页签沿用服务端默认（下单时间倒序，返回 null）。
 */
export function defaultSortFor(statusParam: string): string | null {
  return statusParam === 'paid' ? 'paid_at' : null;
}

export function tabStatusParam(tab: StatusTab): string {
  return tab.statuses.join(',');
}

/**
 * URL 的 `status` → 实际要发的状态集合 + 应高亮的页签。
 * @returns `statuses` 为空数组表示不过滤；`tabKey` 为 null 表示不是任何一个页签（自定义集合）。
 */
export function readStatusFilter(raw: string | null): {
  statuses: OrderStatus[];
  tabKey: string | null;
  /** true = 状态集合只是该页签的**一部分**（如 `status=shipped` 只是「已发货」页签里的一半）。 */
  narrowed: boolean;
} {
  const parsed = raw === null ? null : parseOrderStatusList(raw);
  if (parsed === null) return { statuses: [], tabKey: 'all', narrowed: false };
  const same = (t: StatusTab): boolean =>
    t.statuses.length === parsed.length && t.statuses.every((s) => parsed.includes(s));
  const exact = STATUS_TABS.find(same);
  if (exact !== undefined) return { statuses: parsed, tabKey: exact.key, narrowed: false };
  // AJ-410 / N27：单个状态（工作台待办、收藏的 `status=shipped`）属于某个页签时，高亮那个页签；
  // 筛选仍按 URL 原样（不偷偷扩成整组），页面另说一句"只显示其中的 …"。页签互不相交，所以至多一个匹配。
  const owner = STATUS_TABS.find(
    (t) => t.statuses.length > 0 && parsed.every((s) => t.statuses.includes(s)),
  );
  return { statuses: parsed, tabKey: owner?.key ?? null, narrowed: owner !== undefined };
}

export const DATE_PRESETS: ReadonlyArray<{ key: string; label: string; days?: number }> = [
  { key: '', label: '全部时间' },
  { key: 'today', label: '今天', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: 'custom', label: '自定义' },
];

/**
 * 日期预设（+ 自定义的两端）→ 请求参数（JST 日历日，两端都含）。
 * @returns `error` 非空 = 自定义输入有误（不发请求，页面提示）；两端都缺 = 不限日期。
 */
export function resolveDateRange(
  range: string,
  from: string,
  to: string,
  now: Date,
): { createdFrom?: string; createdTo?: string; error?: string } {
  const preset = DATE_PRESETS.find((p) => p.key === range);
  if (preset?.days !== undefined) {
    return { createdFrom: jstDate(jstDayWindow(now, preset.days).from), createdTo: jstDate(now) };
  }
  if (range !== 'custom') return {};
  const r = parseJstDateRange(from === '' ? undefined : from, to === '' ? undefined : to);
  if (!r.ok) {
    return {
      error: r.reason === 'created_range_invalid' ? '开始日期晚于结束日期' : '日期格式不对',
    };
  }
  return { ...(from !== '' ? { createdFrom: from } : {}), ...(to !== '' ? { createdTo: to } : {}) };
}
