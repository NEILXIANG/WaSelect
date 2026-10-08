/**
 * 职责：客户详情（AJ-404）——资料 / 统计 / 风险与拉黑解除 / 地址簿 / 订单历史。
 *
 * @why 订单号是 `#/orders/:id` 的**链接**而不是按钮：订单详情本来就是深链接（router.ts @limitation 一），
 *      用链接运营可以中键开新页签对照着看，不丢当前客户页。
 * @why 测试单在订单历史里**照列**并打「测试单」徽章：统计已排除它们，但客服要能回答"这单是不是审核单"。
 * @limitation 一：订单历史最多 50 张（服务端上限），更早的去订单页按单号查。
 * @limitation 二：反馈一律走 Toast（第一批①）；取详情失败时保留上一次的数据（与订单详情同口径）。
 * @see ./CustomerRiskActions.tsx；./view.ts；../../../server/src/app/admin-customer-routes.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { Badge } from '../ui/badge.js';
import { formatJst, moneyText } from '../format.js';
import { ORDER_STATUS_LABELS } from '../orders/view.js';
import { getCustomer, type AdminApi } from './api.js';
import { CustomerRiskActions } from './CustomerRiskActions.js';
import { addressLine, riskText, statsCards, type CustomerDetailLike } from './view.js';

export interface CustomerDetailProps {
  api: AdminApi;
  id: string;
  onBack: () => void;
}

function statusLabel(s: string | undefined): string {
  return s !== undefined && s in ORDER_STATUS_LABELS
    ? ORDER_STATUS_LABELS[s as keyof typeof ORDER_STATUS_LABELS]
    : '未知状态';
}

export function CustomerDetail({ api, id, onBack }: CustomerDetailProps) {
  const [c, setC] = useState<CustomerDetailLike | null>(null);
  const [loading, setLoading] = useState(true);
  const sink = useToasts();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setC(await getCustomer(api, id));
    } catch (e) {
      const { text, traceId } = toastError(e, '取客户详情失败');
      sink.error(text, { traceId });
    } finally {
      setLoading(false);
    }
  }, [api, id, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const risk = c === null ? null : riskText(c);

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">客户详情</h1>
        {loading && <span className="muted">加载中…</span>}
        <button type="button" className="link" onClick={onBack}>
          返回列表
        </button>
      </header>
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />

      {c !== null && risk !== null && (
        <>
          <div className="row2">
            <div className="field">
              <span className="label">客户 ID（查运营日志用）</span>
              <span className="muted selectable">{c.id}</span>
            </div>
            <div className="field">
              <span className="label">联系邮箱（最近一单）</span>
              <span className="selectable">{c.contact_email ?? '—'}</span>
            </div>
            <div className="field">
              <span className="label">注册（JST）</span>
              <span>{formatJst(c.created_at)}</span>
            </div>
          </div>

          <div className="stat-cards">
            {statsCards(c.stats).map((s) => (
              <div className="stat-card" key={s.label}>
                <span className="stat-label">{s.label}</span>
                <span className="stat-value">{s.value}</span>
                {s.sub !== '' && <span className="stat-sub">{s.sub}</span>}
              </div>
            ))}
          </div>

          <div className="field">
            <span className="label">风险</span>
            <span className={risk.danger ? 'error' : 'muted'}>{risk.text}</span>
          </div>
          <CustomerRiskActions
            api={api}
            userId={c.id}
            blocked={c.blocked === true}
            sink={sink}
            onChanged={load}
          />

          <span className="label">地址簿</span>
          <table className="table">
            <tbody>
              {c.addresses.map((a, i) => (
                <tr key={a.id ?? i}>
                  <td>
                    {a.recipient ?? '—'}
                    {a.is_default === true && <Badge tone="info">默认</Badge>}
                  </td>
                  <td className="selectable">{a.phone ?? '—'}</td>
                  <td className="selectable">{addressLine(a)}</td>
                </tr>
              ))}
              {c.addresses.length === 0 && (
                <tr>
                  <td className="muted">地址簿为空</td>
                </tr>
              )}
            </tbody>
          </table>

          <span className="label">订单（最近 50 张，新的在前）</span>
          <table className="table">
            <thead>
              <tr>
                <th>订单号</th>
                <th>状态</th>
                <th>合计</th>
                <th>下单（JST）</th>
              </tr>
            </thead>
            <tbody>
              {c.orders.map((o) => (
                <tr key={o.order_id}>
                  <td>
                    <a className="link" href={`#/orders/${encodeURIComponent(o.order_id)}`}>
                      {o.order_no ?? o.order_id}
                    </a>
                    {o.is_test === true && <Badge tone="muted">测试单</Badge>}
                    {o.has_dispute === true && <Badge tone="danger">拒付</Badge>}
                  </td>
                  <td>{statusLabel(o.status)}</td>
                  <td>{moneyText(o.total_jpy)}</td>
                  <td className="muted">{formatJst(o.created_at)}</td>
                </tr>
              ))}
              {c.orders.length === 0 && (
                <tr>
                  <td className="muted" colSpan={4}>
                    还没有下过单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
