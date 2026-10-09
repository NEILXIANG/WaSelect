/**
 * 职责：管理端列表的排序参数 `sort`（WorkBuddy 管理后台评估 4.5，2026-10-09）——服务端与管理端共用一份口径。
 *
 * 形状：`sort=<键>` 升序，`sort=-<键>` 降序；不传 = 各列表的默认排序（订单 / 商品按时间倒序，客户按最近下单倒序）。
 *
 * @why **白名单**而不是"传列名"：键最终落到 SQL 的 ORDER BY——任意列名既是注入面，也会让人点出一个没有索引的全表排序。
 *      每张列表只开 2–3 个运营真正会用的键（金额 / 库存 / 累计实付 / 时间），服务端用 switch 把键映射成固定的 SQL 片段。
 * @why 一个参数而不是 `sort` + `order` 两个：地址栏里是给人看和复制的，`-total_jpy` 一眼能读，两个参数会出现"只有 order 没有 sort"的半态。
 * @limitation 键名与接口字段名同名（`total_jpy` / `stock` / `paid_total_jpy`），改字段名要同步改这里、服务端映射与管理端表头。
 * @see server/src/adapters/orders-admin.ts / catalog-admin.ts / customers-admin.ts（键 → SQL）；admin-web 各列表页（表头点击）
 */

export const LIST_SORT_KEYS = {
  orders: ['created_at', 'total_jpy'],
  products: ['updated_at', 'stock', 'price_jpy'],
  customers: ['last_order_at', 'paid_total_jpy'],
} as const;

export type SortDir = 'asc' | 'desc';

export type ListSortResult<K extends string> =
  { ok: true; key: K | null; dir: SortDir } | { ok: false; reason: 'sort_invalid' };

/**
 * 解析 `sort` 查询参数。
 * @param raw 原始查询值（Express 可能给数组 / 对象；一律按非法处理，不猜取哪一个）
 * @param allowed 该列表的白名单（`LIST_SORT_KEYS.xxx`）
 */
export function parseListSort<K extends string>(
  raw: unknown,
  allowed: readonly K[],
): ListSortResult<K> {
  if (raw === undefined || raw === '') return { ok: true, key: null, dir: 'desc' };
  if (typeof raw !== 'string') return { ok: false, reason: 'sort_invalid' };
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  if (!(allowed as readonly string[]).includes(key)) return { ok: false, reason: 'sort_invalid' };
  return { ok: true, key: key as K, dir: desc ? 'desc' : 'asc' };
}

/**
 * 点表头后 `sort` 应写成什么：换到新的一列从**降序**开始（运营点"金额"想看的是最大的单）；
 * 同一列再点在降序 / 升序之间切换。
 */
export function sortParam(currentKey: string | null, currentDir: SortDir, clicked: string): string {
  if (currentKey !== clicked) return `-${clicked}`;
  return currentDir === 'desc' ? clicked : `-${clicked}`;
}
