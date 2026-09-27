/**
 * 职责：风控页（拒付列表 + 拉黑用户）。
 *
 * @why 拉黑做成**两步：先取订单详情拿 user_id，再二次确认拉黑**——
 *      契约的 `Dispute` 里没有 user_id（@see ./view.ts @limitation 一），
 *      而契约**只有拉黑、没有解除**（@limitation 二），
 *      所以点下去之前必须让运营看见"要拉黑的是谁"，以及"这一步没有回头路"。
 *
 * @limitation 一：证据提交**不在后台做**（契约明文：证据在 Stripe Dashboard 提交），
 *              后台只标红、锁退款、拉黑——所以这里刻意**不放**"提交证据"按钮，
 *              避免运营以为在这里传了材料就算完成举证。
 * @limitation 二：复用订单模块的 `getOrder` 拿 user_id（不为它另起一份封装）；
 *              跨模块只引用**接口层**函数，不引用页面。
 *
 * @see ./view.ts；./api.ts；../orders/api.ts（getOrder）；契约 D-50
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { getOrder } from '../orders/api.js';
import { blockUser, listDisputes, type AdminApi } from './api.js';
import {
  BLOCK_CONFIRM_TEXT,
  DISPUTE_STATUS,
  DISPUTE_STATUS_LABELS,
  disputeRows,
  orderUserId,
} from './view.js';

export interface RiskPageProps {
  api: AdminApi;
}

export function RiskPage({ api }: RiskPageProps) {
  const [rows, setRows] = useState<ReturnType<typeof disputeRows>>([]);
  const [status, setStatus] = useState<'all' | (typeof DISPUTE_STATUS)[number]>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  /** 正在处理的订单（先取详情拿 user_id）。 */
  const [orderId, setOrderId] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(disputeRows(await listDisputes(api, status === 'all' ? undefined : status)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, status]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 第一步：取订单详情 → 拿到 user_id。 */
  const prepare = async (id: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const order = await getOrder(api, id);
      const uid = orderUserId(order);
      setOrderId(id);
      setUserId(uid);
      if (uid === '') setError('该订单详情里没有 user_id（拉黑需要它）');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = async (): Promise<void> => {
    setBusy(true);
    try {
      await blockUser(api, userId);
      setOk(`已拉黑 ${userId}（该用户此后建单会被拒 40301）`);
      setOrderId('');
      setUserId('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">风控：拒付与拉黑</h1>
        {loading && <span className="muted">加载中…</span>}
      </header>

      <p className="muted">
        证据在 Stripe Dashboard 提交——后台只标红、锁退款、拉黑，不在此处举证。
      </p>

      <div className="filters">
        <select
          className="input"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          <option value="all">全部</option>
          {DISPUTE_STATUS.map((s) => (
            <option key={s} value={s}>
              {DISPUTE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {error !== '' && <p className="error">{error}</p>}
      {ok !== '' && <p className="ok">{ok}</p>}

      <table className="table">
        <thead>
          <tr>
            <th>订单号</th>
            <th>状态</th>
            <th>争议金额（原币）</th>
            <th>开案（JST）</th>
            <th>结案（JST）</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.disputeId}-${i}`}>
              <td>{r.orderNo}</td>
              <td className={r.urgent ? 'error' : 'muted'}>{r.statusText}</td>
              <td>{r.amountText}</td>
              <td className="muted">{r.openedText}</td>
              <td className="muted">{r.closedText}</td>
              <td>
                <button
                  type="button"
                  className="link"
                  disabled={busy || r.orderId === ''}
                  onClick={() => void prepare(r.orderId)}
                >
                  处理
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={6}>
                没有拒付记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {orderId !== '' && userId !== '' && (
        <div className="form">
          <span className="label">拉黑用户</span>
          <span className="muted">
            订单 {orderId} · 用户 {userId}
          </span>
          <span className="error">{BLOCK_CONFIRM_TEXT}</span>
          <div className="row2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void confirmBlock()}
            >
              确认拉黑
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setOrderId('');
                setUserId('');
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
