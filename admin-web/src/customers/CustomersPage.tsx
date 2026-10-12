/**
 * 职责：客户页（AJ-404；对标分析 §4.5）——列表（搜索 + 翻页）；`#/customers/:id` 时渲染详情。
 *
 * @why 关键字与页码**进地址栏**（与订单页同口径，router.ts）：客服把"搜出来的那个人"发给同事，链接要打到同一屏。
 * @why 搜索走按钮 / 回车提交，不做输入即搜：每敲一个字打一次全表扫描（customers-admin.ts @limitation 二）不值得。
 * @limitation 列表只读；拉黑 / 解除在详情页（CustomerDetail.tsx），风控页保留原入口并链到这里。
 * @see ./CustomerDetail.tsx；./view.ts；./api.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { LIST_SORT_KEYS, SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { PageSizeSelect, readListParams, SortTh } from '../ui/list-controls.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { Badge } from '../ui/badge.js';
import type { Route } from '../router.js';
import { listCustomers, type AdminApi } from './api.js';
import { CustomerDetail } from './CustomerDetail.js';
import { customerListQuery, customerRows, type CustomerRow } from './view.js';

export interface CustomersPageProps {
  api: AdminApi;
  route: Route;
  onNavigate: (next: Route) => void;
}

function toQuery(keyword: string, page: number, sort = '', size = 20): URLSearchParams {
  return new URLSearchParams(customerListQuery({ keyword, page, sort, size }).replace(/^\?/, ''));
}

export function CustomersPage({ api, route, onNavigate }: CustomersPageProps) {
  if (route.id !== '') {
    return (
      <CustomerDetail
        api={api}
        id={route.id}
        onBack={() => onNavigate({ page: 'customers', id: '', query: new URLSearchParams() })}
      />
    );
  }
  // key = 查询串：后退 / 手改地址栏换了关键字时，输入框跟着地址栏重置（地址栏是唯一真源）
  return (
    <CustomerList
      key={route.query.toString()}
      api={api}
      query={route.query}
      onNavigate={onNavigate}
    />
  );
}

function CustomerList({
  api,
  query,
  onNavigate,
}: {
  api: AdminApi;
  query: URLSearchParams;
  onNavigate: (next: Route) => void;
}) {
  const keyword = query.get('keyword') ?? '';
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  // 评估 4.5 / 4.6（2026-10-09）：排序与每页条数进地址栏（ui/list-controls.tsx）
  const { sortKey, sortDir, size } = readListParams(query, LIST_SORT_KEYS.customers);
  const sortStr = sortKey === null ? '' : `${sortDir === 'desc' ? '-' : ''}${sortKey}`;
  const [input, setInput] = useState(keyword);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const sink = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listCustomers(api, {
        keyword,
        page,
        size,
        ...(sortStr !== '' ? { sort: sortStr } : {}),
      });
      setRows(customerRows(r.items));
      setTotal(r.total);
    } catch (e) {
      const { text, traceId } = toastError(e, '取客户列表失败');
      sink.error(text, { traceId });
    } finally {
      setLoading(false);
    }
  }, [api, keyword, page, size, sortStr, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const go = (kw: string, p: number, s = sortStr, n = size): void =>
    onNavigate({ page: 'customers', id: '', query: toQuery(kw, p, s, n) });
  const onSort = (s: string): void => go(keyword, 1, s);
  const lastPage = Math.max(1, Math.ceil(total / size));

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">客户</h1>
        {loading && <span className="muted">加载中…</span>}
      </header>

      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          go(input, 1);
        }}
      >
        <input
          className="input"
          name="customer-keyword"
          maxLength={SEARCH_KEYWORD_MAX_LENGTH}
          placeholder="例：zhang.wei@example.com / 260901-K7Q2MN / Zhang Wei"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary">
          搜索
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            {/* 全入口点击测试 2026-10-11：第一列写能认出人的名字（最近收件人），编号挪到操作前、灰字（原第一列是截短的用户 id） */}
            <th>客户</th>
            <th>联系邮箱</th>
            <th>订单</th>
            <SortTh
              label={<span title="已付款订单合计，不扣退款">累计付款</span>}
              sortKey="paid_total_jpy"
              currentKey={sortKey ?? 'last_order_at'}
              currentDir={sortDir}
              onSort={onSort}
            />
            <SortTh
              label="最近下单（日本时间）"
              sortKey="last_order_at"
              currentKey={sortKey ?? 'last_order_at'}
              currentDir={sortDir}
              onSort={onSort}
            />
            <th>状态</th>
            <th>编号</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="selectable cell-ellipsis" title={r.email}>
                {r.email}
              </td>
              <td className="cell-nowrap">{r.ordersText}</td>
              <td className="cell-nowrap">{r.paidTotalText}</td>
              <td className="muted cell-nowrap">{r.lastOrderText}</td>
              <td>{r.blocked && <Badge tone="danger">已拉黑</Badge>}</td>
              <td className="muted cell-nowrap">{r.idText}</td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    onNavigate({ page: 'customers', id: r.id, query: new URLSearchParams() })
                  }
                >
                  详情
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={8}>
                {/* 全入口点击测试 2026-10-12：搜空了给一键清除（与商品 / 订单列表同）；没搜时是"还没有客户" */}
                {keyword !== '' ? (
                  <>
                    没有符合条件的客户{' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setInput('');
                        go('', 1);
                      }}
                    >
                      清除搜索
                    </button>
                  </>
                ) : (
                  '还没有客户'
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="pager">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page <= 1}
          onClick={() => go(keyword, page - 1)}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {lastPage} 页 · 共 {total} 位
        </span>
        <PageSizeSelect size={size} onChange={(n) => go(keyword, 1, sortStr, n)} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page >= lastPage}
          onClick={() => go(keyword, page + 1)}
        >
          下一页
        </button>
      </footer>
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
    </section>
  );
}
