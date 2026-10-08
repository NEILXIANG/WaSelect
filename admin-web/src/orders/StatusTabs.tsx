/**
 * 职责：订单列表的状态页签 + 每个页签的计数（AJ-400，对标 §4.1「状态页签 + 计数」，取代原来的状态下拉与页内待办条）。
 *
 * @why 计数沿用 TodoBar 的取法——列表接口 `size=1` 取 `total`，不新增统计接口：
 *      计数与点进去看到的列表是**同一条查询**（同一组过滤条件），不会出现"页签说 3 单、点进去 2 单"。
 *      计数带上当前的关键词 / 日期 / 含测试单，只换状态：运营筛了"近 7 天"后看的是"近 7 天里各有几单"。
 * @tradeoff 七个页签 = 每次筛选变化多发七个轻量请求（各一条 count + 一行）。单人运营、日百单量级下可忽略；
 *           换来的是零后端改动与口径天然一致。量起来再合并成一个聚合接口。
 * @limitation 计数在筛选变化与 `refreshKey` 变化时刷新，不轮询；某一格取数失败显示"—"，不挡页面。
 * @see ./list-filter.ts（页签定义与 URL 读法）；./TodoBar.tsx（工作台仍用它）；./OrdersPage.tsx
 */
import { useEffect, useState } from 'react';
import { listOrders, type AdminApi, type OrderListQuery } from './api.js';
import { STATUS_TABS, type StatusTab } from './list-filter.js';

export function StatusTabs({
  api,
  current,
  base,
  refreshKey,
  onPick,
}: {
  api: AdminApi;
  /** 当前高亮的页签 key；null = 当前筛选不是任何一个页签。 */
  current: string | null;
  /** 除状态外的过滤条件（计数用）。 */
  base: Omit<OrderListQuery, 'status' | 'page' | 'size'>;
  refreshKey: number;
  onPick: (tab: StatusTab) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  // 依赖用字符串化的 base：调用方每次渲染都新建对象，直接放进依赖会每次渲染都重发七个请求
  const baseKey = JSON.stringify(base);

  useEffect(() => {
    let alive = true;
    const q = JSON.parse(baseKey) as typeof base;
    void Promise.all(
      STATUS_TABS.map((t) =>
        listOrders(api, { ...q, status: t.statuses, size: 1 })
          .then((r) => [t.key, r.total] as const)
          .catch(() => [t.key, null] as const),
      ),
    ).then((pairs) => {
      if (alive) setCounts(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [api, baseKey, refreshKey]);

  return (
    <div className="tabs" role="tablist" aria-label="订单状态">
      {STATUS_TABS.map((t) => {
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={current === t.key}
            className={current === t.key ? 'tab tab-on' : 'tab'}
            onClick={() => onPick(t)}
          >
            {t.label}
            <span className="tab-count">{n === undefined ? '…' : n === null ? '—' : n}</span>
          </button>
        );
      })}
    </div>
  );
}
