/**
 * 职责：列表页共用的两个小控件（WorkBuddy 管理后台评估 4.5 / 4.6，2026-10-09）——
 *       可点击排序的表头 `SortTh`、每页条数选择 `PageSizeSelect`；以及从地址栏读这两样的 `readListParams`。
 *
 * @why 放 ui/ 一份而不是三个列表页各写一遍：表头"点一下降序、再点升序"的规则（shared `sortParam`）、
 *      条数只给 20 / 50 / 100 三档、地址栏参数名，三处各写会各漂一次——
 *      运营在订单页学会的点法，到了商品页不一样，就是这类后台最常见的"用着别扭"。
 * @why 表头用 `<button>` 套在 `<th>` 里并带 `aria-sort`：键盘可达、读屏能读出当前排序；箭头只是辅助，
 *      当前排序列另有加粗（不只靠一个小符号表达状态）。
 * @limitation 只有白名单里的列可点（shared `LIST_SORT_KEYS`）；其余列是普通 `<th>`，看起来也不像能点。
 * @see packages/shared/src/list-sort.ts（解析与点击规则的唯一真源）
 */
import { parseListSort, sortParam, type SortDir } from '@waselect/shared';
import type { ReactNode } from 'react';

/** 每页条数可选值（服务端上限 100，契约 0.6.53）。 */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

export interface ListParams<K extends string> {
  sortKey: K | null;
  sortDir: SortDir;
  size: number;
}

/**
 * 从地址栏读排序与条数。
 * @why 认不出的值（手改地址栏、旧收藏）回落成默认，而不是把非法值发给服务端拿一个 40001：
 *      地址栏是给人看和复制的，坏了一个参数整页报错，运营只会以为"后台坏了"。
 */
export function readListParams<K extends string>(
  query: URLSearchParams,
  allowed: readonly K[],
): ListParams<K> {
  const s = parseListSort(query.get('sort') ?? undefined, allowed);
  const sizeRaw = Number(query.get('size') ?? DEFAULT_PAGE_SIZE);
  const size = (PAGE_SIZE_OPTIONS as readonly number[]).includes(sizeRaw)
    ? sizeRaw
    : DEFAULT_PAGE_SIZE;
  return s.ok ? { sortKey: s.key, sortDir: s.dir, size } : { sortKey: null, sortDir: 'desc', size };
}

export interface SortThProps {
  label: ReactNode;
  /** 这一列的排序键。 */
  sortKey: string;
  /** 当前生效的排序（地址栏里没有 = 列表默认排序，传默认键与方向，让默认列也显示箭头）。 */
  currentKey: string | null;
  currentDir: SortDir;
  /** 点了之后 `sort` 应写成的值（`-key` / `key`），由调用方写进地址栏。 */
  onSort: (sort: string) => void;
}

export function SortTh({ label, sortKey, currentKey, currentDir, onSort }: SortThProps) {
  const active = currentKey === sortKey;
  const ariaSort = active ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th aria-sort={ariaSort}>
      <button
        type="button"
        className={active ? 'th-sort th-sort-on' : 'th-sort'}
        title={active ? '点一下换方向' : '点一下按这一列排序（先从大到小）'}
        onClick={() => onSort(sortParam(currentKey, currentDir, sortKey))}
      >
        {label}
        <span className="th-sort-arrow" aria-hidden="true">
          {active ? (currentDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

export interface PageSizeSelectProps {
  size: number;
  onChange: (size: number) => void;
}

export function PageSizeSelect({ size, onChange }: PageSizeSelectProps) {
  return (
    <label className="page-size">
      <span className="muted">每页</span>
      <select
        className="input input-compact"
        aria-label="每页显示条数"
        value={size}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n} 条
          </option>
        ))}
      </select>
    </label>
  );
}
