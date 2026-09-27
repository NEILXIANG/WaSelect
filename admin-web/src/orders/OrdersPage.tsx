/**
 * 职责：订单列表页（状态筛选 / 关键词搜索 / 分页 / 去详情）。
 *
 * @why **筛选条件变了要回到第 1 页**：不回的话会出现"筛选后停在第 3 页、
 *      结果只有 2 条但页面显示空白"，运营会以为订单消失了。
 *
 * @limitation 一：列表接口返回 `AdminOrderListItem`（契约 0.6.1），**带** `has_dispute`，
 *              所以"拒付中"在列表页就能显示徽标（0.6.1 之前列表没有这个字段，
 *              只能"看到标记才显示"——那条兜底现在仍在：不因为"没查到"就声称没有拒付）。
 *              ⚠️ 徽标的真值以**详情**为准：列表是缓存的一次快照，详情页会重新拉单条。
 * @limitation 二：详情是**整块替换列表**（不是弹层）：详情要展示商品行、地址、支付、
 *              事件时间线，弹层放不下；代价是返回时要重新拉一次列表（见 @why 刷新）。
 * @limitation 三：关键词搜索是**显式点搜索**（不是边打边搜）——
 *              每敲一个字发一次请求会让分页与结果在输入过程中反复抖动，
 *              而运营搜单号通常是整段粘贴。
 *
 * @see ./view.ts（行视图与闸门）；./api.ts（接口层）；./OrderDetail.tsx
 */
import { useCallback, useEffect, useState } from 'react';
import type { OrderStatus } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { listOrders, type AdminApi, type AdminOrderLike } from './api.js';
import { STATUS_FILTER_OPTIONS, orderRows, type OrderRow } from './view.js';
import { OrderDetail } from './OrderDetail.js';

/** 每页条数（契约默认 20；与商品管理同口径，一屏放得下）。 */
const PAGE_SIZE = 20;

export interface OrdersPageProps {
  api: AdminApi;
}

export function OrdersPage({ api }: OrdersPageProps) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  /** 服务端原始条目：详情页要先拿到 has_dispute 才知道能不能退款（@see @limitation 一）。 */
  const [raw, setRaw] = useState<AdminOrderLike[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  /** 输入框里的值（未提交）；提交后写进 `applied`。 */
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 当前打开的订单 id（null = 看列表）。 */
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listOrders(api, {
        page,
        size: PAGE_SIZE,
        keyword: applied,
        ...(status === 'all' ? {} : { status }),
      });
      setRaw(res.items);
      setRows(orderRows(res.items));
      setTotal(res.total);
    } catch (e) {
      // ⚠️ 失败不清列表（同商品管理）：只显示错误，列表保留上一次结果
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, page, status, applied]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (detailId !== null) {
    return (
      <OrderDetail
        api={api}
        id={detailId}
        source={raw.find((o) => o.order_id === detailId) ?? null}
        onBack={() => {
          setDetailId(null);
          void load();
        }}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">订单管理</h1>
        <span className="muted">时间均为 JST</span>
      </header>

      <div className="filters">
        <select
          className="input"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as OrderStatus | 'all');
            setPage(1);
          }}
        >
          {STATUS_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="单号 / 收件人 / 运单号"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setApplied(keyword.trim());
            setPage(1);
          }}
        >
          搜索
        </button>
      </div>

      {error !== '' && <p className="error">{error}</p>}
      {loading && <p className="muted">加载中…</p>}
      {!loading && rows.length === 0 && error === '' && <p className="muted">没有符合条件的订单</p>}

      <table className="table">
        <thead>
          <tr>
            <th>订单号</th>
            <th>状态</th>
            <th>金额</th>
            <th>下单时间</th>
            <th>收件人</th>
            <th>物流</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.orderNo}</td>
              <td>
                {row.statusText}
                {row.hasDispute && <span className="error"> · 拒付中</span>}
                {row.isTest && <span className="muted"> · 测试单</span>}
              </td>
              <td>{row.totalText}</td>
              <td className="muted">{row.createdText}</td>
              <td>{row.recipientText}</td>
              <td className="muted">{row.shipText === '' ? '—' : row.shipText}</td>
              <td>
                <button type="button" className="link" onClick={() => setDetailId(row.id)}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="pager">
        <button
          type="button"
          className="btn"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {lastPage} 页 · 共 {total} 单
        </span>
        <button
          type="button"
          className="btn"
          disabled={page >= lastPage}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
