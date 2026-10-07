/**
 * 职责：订单页顶部的"待办"计数（三端联动 UI 模拟 2026-10-08）——待发货 / 退款中 / 待付款，点一下即筛到那一类。
 *
 * @why 主流电商后台的首屏都是"今天要处理什么"：原先运营要自己在状态下拉里逐个切，才知道有几张单等着发货。
 *      待发货是最要紧的一类（发货时限承诺，SHIP_WITHIN_BUSINESS_DAYS），退款中是机构侧没落定的钱。
 * @why 用列表接口的 `total`（size=1）取数，不新增统计接口：三次轻量查询换零后端改动；
 *      计数与列表口径天然一致（同一个过滤条件），不会出现"角标说 3 张、点进去 2 张"。
 * @limitation 计数在挂载与 `refreshKey` 变化时刷新，不轮询；取数失败的那一格显示"—"，不挡页面。
 * @see ./OrdersPage.tsx
 */
import { useEffect, useState } from 'react';
import type { OrderStatus } from '@waselect/shared';
import { listOrders, type AdminApi } from './api.js';

const TODO: ReadonlyArray<{ status: OrderStatus; label: string }> = [
  { status: 'paid', label: '待发货' },
  { status: 'refunding', label: '退款中' },
  { status: 'pending_payment', label: '待付款' },
];

export function TodoBar({
  api,
  refreshKey = 0,
  current,
  onPick,
}: {
  api: AdminApi;
  refreshKey?: number;
  /** 当前筛选状态（对应那一格高亮）。 */
  current: OrderStatus | 'all';
  onPick: (status: OrderStatus) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let alive = true;
    void Promise.all(
      TODO.map((t) =>
        listOrders(api, { status: t.status, size: 1 })
          .then((r) => [t.status, r.total] as const)
          .catch(() => [t.status, null] as const),
      ),
    ).then((pairs) => {
      if (alive) setCounts(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [api, refreshKey]);

  return (
    <div className="chips" aria-label="待办">
      {TODO.map((t) => {
        const n = counts[t.status];
        return (
          <button
            key={t.status}
            type="button"
            className={current === t.status ? 'chip chip-on' : 'chip'}
            onClick={() => onPick(t.status)}
          >
            {t.label} {n === undefined ? '…' : n === null ? '—' : n}
          </button>
        );
      })}
    </div>
  );
}
