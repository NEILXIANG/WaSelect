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
  type DisputeRow,
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
  /** 面板上显示的订单号（`order_no`），不是 UUID——运营是按订单号认单的（ADM3-01）。 */
  const [orderNo, setOrderNo] = useState('');
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

  /**
   * 第一步：取订单详情 → 拿到 user_id。
   *
   * @why **进来第一件事是清空上一次的待确认状态**（ADM3-01）：
   *      拉黑不可逆、契约没有解除接口，而取详情是会失败的（超时 / 5xx 都可能）。
   *      不清空的后果是——对 A 单取详情成功、再对 B 单取详情失败时，
   *      页面顶部出现红字、底部确认面板却**仍是 A 的**，
   *      运营以为面板是刚点的那一单，点下去拉黑的是 A 的用户。
   *      这不是"显示错误"，是**对一个不相干的人执行不可逆操作**。
   * @why 收整行 `r` 而不是只收 `id`：面板要显示 `order_no`（运营认单用的是订单号），
   *      而列表行里本来就有，不必再从详情里找、也不必另存一份映射。
   */
  const prepare = async (r: DisputeRow): Promise<void> => {
    setBusy(true);
    setError('');
    setOk('');
    setOrderId('');
    setOrderNo('');
    setUserId('');
    // ⚠️ 不写"响应属于哪一单"的乱序核对：`busy` 已经把"处理"按钮禁用，
    //    同一时刻只可能有一个 `prepare` 在飞，乱序**不会发生**。
    //    加了就是一段永远走不到、也因此永远测不到的分支（约束护栏必须有红灯证据）。
    try {
      const order = await getOrder(api, r.orderId);
      const uid = orderUserId(order);
      setOrderId(r.orderId);
      setOrderNo(r.orderNo);
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
    // 不清的话，"已拉黑"与上一次失败留下的红字会同时出现在页面上（ADM3-01 附带）
    setError('');
    setOk('');
    try {
      // 带上 order_id 让服务端核对"这张单属于这个人"（ADM3-01 纵深防御 / AJ-290）：
      // 拉黑不可逆、没有解除接口，多一道凭据核对的成本是请求体里多一个字段。
      // ⚠️ 它**不是**"防手滑"——防手滑靠的是 prepare 清空待确认态（AJ-256）；
      //    这里防的是"order_id 与 user_id 配错"这类请求级错误。
      await blockUser(api, { userId, orderId });
      setOk(`已拉黑 ${userId}（该用户此后建单会被拒 40301）`);
      setOrderId('');
      setOrderNo('');
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
                  onClick={() => void prepare(r)}
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
            {/* 显示 order_no：列表行给运营看的是订单号，而 order_id 是 UUID——两个对不上，
                运营没法把面板上这一行和列表里的哪一行对起来（ADM3-01）。
                order_no 缺失时退化到 UUID：宁可显示一个看不懂的串，也不要显示一个空档。 */}
            订单 {orderNo !== '' ? orderNo : orderId} · 用户 {userId}
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
