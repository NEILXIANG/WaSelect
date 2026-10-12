/**
 * 职责：订单页「待处理」那一排——每一类写上单数，点一类筛到那一类（第三轮走查 2026-10-12）。
 *
 * @why 原先只有类名没有数字，运营要逐个点开才知道哪一类有单；工作台的待办格早就带计数（TodoBar），
 *      这里沿用同一取数法：列表接口 size=1 取 `total`，计数与点进去的列表同一个过滤条件，不会对不上。
 * @tradeoff 每次进订单页多 6 个轻量查询；换来的是不用新增统计接口、口径天然一致。
 * @limitation 只在挂载与 `refreshKey` 变化时取数，不轮询；某一类取数失败写"—"，仍可点。
 * @see ./TodoBar.tsx
 */
import { useEffect, useState } from 'react';
import { ORDER_ATTENTION_LABELS, ORDER_ATTENTIONS, type OrderAttention } from '@waselect/shared';
import { listOrders, type AdminApi } from './api.js';

export function AttentionLinks({
  api,
  refreshKey = 0,
  onPick,
}: {
  api: AdminApi;
  refreshKey?: number;
  onPick: (attention: OrderAttention) => void;
}) {
  const [counts, setCounts] = useState<Partial<Record<OrderAttention, number | null>>>({});

  useEffect(() => {
    let alive = true;
    void Promise.all(
      ORDER_ATTENTIONS.map((a) =>
        listOrders(api, { attention: a, size: 1 })
          .then((r) => [a, r.total] as const)
          .catch(() => [a, null] as const),
      ),
    ).then((pairs) => {
      if (alive) setCounts(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [api, refreshKey]);

  return (
    <p className="muted">
      待处理：
      {ORDER_ATTENTIONS.map((a) => {
        const n = counts[a];
        return (
          <button
            key={a}
            type="button"
            // 0 单收淡（没有要处理的事），仍可点
            className={n === 0 ? 'link muted' : 'link'}
            onClick={() => onPick(a)}
          >
            {ORDER_ATTENTION_LABELS[a]} {n === undefined ? '…' : n === null ? '—' : String(n)}
          </button>
        );
      })}
    </p>
  );
}
