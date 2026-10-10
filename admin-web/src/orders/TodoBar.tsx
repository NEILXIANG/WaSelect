/**
 * 职责：工作台的"待办"计数（三端联动 UI 模拟 2026-10-08）——待发货 / 退款中 / 待付款，以及 AJ-425 的三类待处理，点一下即筛到那一类。
 *
 * @why 主流电商后台的首屏都是"今天要处理什么"：原先运营要自己在状态下拉里逐个切，才知道有几张单等着发货。
 *      待发货是最要紧的一类（发货时限承诺，SHIP_WITHIN_BUSINESS_DAYS），退款中是机构侧没落定的钱。
 * @why 用列表接口的 `total`（size=1）取数，不新增统计接口：三次轻量查询换零后端改动；
 *      计数与列表口径天然一致（同一个过滤条件），不会出现"角标说 3 张、点进去 2 张"。
 * @limitation 计数在挂载与 `refreshKey` 变化时刷新，不轮询；取数失败的那一格显示"—"，不挡页面。
 * @limitation 「待付款」含 created（买家还没点付款）——它不是运营能处理的事，放在待办里只作"有多少钱还悬着"的参考。
 * @see ./OrdersPage.tsx
 */
import { useEffect, useState } from 'react';
import {
  ORDER_ATTENTION_LABELS,
  ORDER_ATTENTIONS,
  type OrderAttention,
  type OrderStatus,
} from '@waselect/shared';
import { listOrders, type AdminApi } from './api.js';
import { STATUS_TABS, tabStatusParam } from './list-filter.js';

/**
 * 待办格对应的查询条件：按订单状态（URL 写法，可逗号分隔多个），或按待处理类（AJ-425）。
 * @why `status` 取 URL 的字符串写法而不是单个状态：「待付款」是 created + pending_payment 两态，
 *      点过去要和订单页「待付款」页签是同一个集合（见下方 UNPAID_STATUS）。
 */
export type TodoQuery = { status: string } | { attention: OrderAttention };

/**
 * 「待付款」的状态集合**取订单页页签的定义**，不在这里另写一份。
 * @why 三端联动模拟（2026-10-10）：原先这一格只数 pending_payment（买家正在付款），
 *      而订单页「待付款」页签是 created + pending_payment——同一个词两个口径，
 *      工作台显示"待付款 0"，点进订单页「待付款」却有单，新手会以为数据不同步。
 */
const unpaidTab = STATUS_TABS.find((t) => t.key === 'unpaid');
// 找不到就在加载时炸：静默回落成别的页签，计数会变成"全部订单数"而没人发现
if (unpaidTab === undefined) throw new Error('list-filter 缺少 unpaid 页签');
const UNPAID_STATUS = tabStatusParam(unpaidTab);

/**
 * @why AJ-425（统一结论 5.1 / U10）：售后申请、迟到付款、拉黑用户的已付单都是"交给运营处理、却没有入口能发现"的单，
 *      进待办条——工作台第一眼就能看见。文案取 shared `ORDER_ATTENTION_LABELS`，与服务端白名单同源。
 */
const TODO: ReadonlyArray<{ key: string; query: TodoQuery; label: string }> = [
  { key: 'paid', query: { status: 'paid' }, label: '待发货' },
  { key: 'refunding', query: { status: 'refunding' }, label: '退款中' },
  { key: 'unpaid', query: { status: UNPAID_STATUS }, label: '待付款' },
  ...ORDER_ATTENTIONS.map((a) => ({
    key: `attention:${a}`,
    query: { attention: a } as TodoQuery,
    label: ORDER_ATTENTION_LABELS[a],
  })),
];

/**
 * 待办格的样式（AJ-410 / N7）。
 * @why 原先与筛选小标签同一个样式，新手看不出能点；现在是带「去处理 →」的按钮，
 *      **有待办（> 0）时用提醒色**——0 单与 3 单长得一样，等于没提醒。取数失败 / 加载中不算有待办。
 */
export function todoChipClass(on: boolean, n: number | null | undefined): string {
  const base = on ? 'chip chip-on todo-chip' : 'chip todo-chip';
  return typeof n === 'number' && n > 0 ? `${base} todo-chip-due` : base;
}

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
  onPick: (query: TodoQuery) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let alive = true;
    void Promise.all(
      TODO.map((t) =>
        listOrders(api, {
          ...('status' in t.query
            ? { status: t.query.status.split(',') as OrderStatus[] }
            : { attention: t.query.attention }),
          size: 1,
        })
          .then((r) => [t.key, r.total] as const)
          .catch(() => [t.key, null] as const),
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
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            type="button"
            className={todoChipClass('status' in t.query && current === t.query.status, n)}
            onClick={() => onPick(t.query)}
          >
            {t.label} {n === undefined ? '…' : n === null ? '—' : n} · 去处理 →
          </button>
        );
      })}
    </div>
  );
}
