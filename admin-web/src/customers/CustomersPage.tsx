/**
 * 职责：客户页（AJ-404；对标分析 §4.5）——列表（搜索 + 翻页）；`#/customers/:id` 时渲染详情。
 *
 * @why 关键字与页码**进地址栏**（与订单页同口径，router.ts）：客服把"搜出来的那个人"发给同事，链接要打到同一屏。
 * @why 搜索走按钮 / 回车提交，不做输入即搜：每敲一个字打一次全表扫描（customers-admin.ts @limitation 二）不值得。
 * @limitation 列表只读；拉黑 / 解除在详情页（CustomerDetail.tsx），风控页保留原入口并链到这里。
 * @see ./CustomerDetail.tsx；./view.ts；./api.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { Badge } from '../ui/badge.js';
import type { Route } from '../router.js';
import { listCustomers, type AdminApi } from './api.js';
import { CustomerDetail } from './CustomerDetail.js';
import { customerListQuery, customerRows, type CustomerRow } from './view.js';

/** 与服务端默认 size 一致（契约 0.6.47：默认 20）。 */
const PAGE_SIZE = 20;

export interface CustomersPageProps {
  api: AdminApi;
  route: Route;
  onNavigate: (next: Route) => void;
}

function toQuery(keyword: string, page: number): URLSearchParams {
  return new URLSearchParams(customerListQuery({ keyword, page }).replace(/^\?/, ''));
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
  const [input, setInput] = useState(keyword);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const sink = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listCustomers(api, { keyword, page });
      setRows(customerRows(r.items));
      setTotal(r.total);
    } catch (e) {
      const { text, traceId } = toastError(e, '取客户列表失败');
      sink.error(text, { traceId });
    } finally {
      setLoading(false);
    }
  }, [api, keyword, page, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const go = (kw: string, p: number): void =>
    onNavigate({ page: 'customers', id: '', query: toQuery(kw, p) });
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
            <th>客户</th>
            <th>最近收件人</th>
            <th>联系邮箱</th>
            <th>订单</th>
            <th>累计实付</th>
            <th>最近下单（JST）</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="muted">{r.idText}</td>
              <td>{r.name}</td>
              <td className="selectable cell-ellipsis" title={r.email}>
                {r.email}
              </td>
              <td className="cell-nowrap">{r.ordersText}</td>
              <td className="cell-nowrap">{r.paidTotalText}</td>
              <td className="muted">{r.lastOrderText}</td>
              <td>{r.blocked && <Badge tone="danger">已拉黑</Badge>}</td>
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
                没有符合条件的客户
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
