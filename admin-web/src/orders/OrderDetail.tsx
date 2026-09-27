/**
 * 职责：订单详情 + 两个不可逆动作（发货 / 退款）。
 *
 * @why **打开详情时重新拉一次单条**（`GET /admin/orders/{id}`）而不是只用列表带过来的数据：
 *      列表（`AdminOrderListItem`）给的是**摘要**——没有 `items` / `address` / `payments` /
 *      `events`，而详情页整块就是这些；同时列表是打开页面那一刻的快照，
 *      期间订单可能已被别人改过（两个客服同时看一单）。
 *      ⚠️ 0.6.1 起列表也带 `has_dispute`，所以"按钮亮着、点了一定失败"这一条已不再是主因，
 *      但"快照可能过期"仍在——重新拉取解决的是后者。
 *
 * @why 退款是**两步确认**（点「退款」→ 出现「确认退款 / 取消」）而不是一次性提交：
 *      退款是钱出去的动作，且 MVP 只支持全额退款、没有"撤销"。
 *      ⚠️ 二次确认不能替代闸门——它只防误点，不防"这单本来就不该退"。
 *
 * @limitation 一：**改址不在这里**（`OrderAddressForm` 单独一个组件接进来），
 *              它要七个美式地址字段，塞进本页会把详情挤成两屏。
 * @limitation 二：发货 / 退款成功后**刷新整页详情**而不是本地改状态——
 *              状态迁移的结果（refunding → refunded）由服务端决定，
 *              前端猜一个"已退款"会出现"页面说退了、实际还在处理"。
 *
 * @see ./view.ts（闸门与请求体）；./api.ts；../../../contracts/api-contract.yaml（AdminOrder）
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { getOrder, refundOrder, shipOrder, type AdminApi, type AdminOrderLike } from './api.js';
import { formatJst, moneyText } from '../format.js';
import { OrderAddressForm } from './OrderAddressForm.js';
import {
  addressSummary,
  emptyRefundForm,
  emptyShipForm,
  paymentSummary,
  refundErrors,
  refundGate,
  shipErrors,
  shipGate,
  toRefundBody,
  toShipBody,
} from './view.js';

export interface OrderDetailProps {
  api: AdminApi;
  id: string;
  /** 列表带过来的原始数据（可能缺 has_dispute；仅作兜底显示）。 */
  source: AdminOrderLike | null;
  onBack: () => void;
  /** 发生了写操作（列表要刷新）。 */
  onChanged: () => void;
}

export function OrderDetail({ api, id, source, onBack, onChanged }: OrderDetailProps) {
  const [order, setOrder] = useState<AdminOrderLike | null>(source);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ship, setShip] = useState(emptyShipForm);
  const [refund, setRefund] = useState(emptyRefundForm);
  /** 退款的两步确认（null = 未发起）。 */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setOrder(await getOrder(api, id));
    } catch (e) {
      // ⚠️ 取详情失败**不清空已有数据**：留着上一次的列表面也比整页空白好排查
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const shipG = shipGate(order);
  const refundG = refundGate(order);

  const doShip = async (): Promise<void> => {
    const check = shipErrors(ship);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setBusy('ship');
    try {
      await shipOrder(api, id, toShipBody(ship));
      setShip(emptyShipForm());
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const doRefund = async (): Promise<void> => {
    const check = refundErrors(refund);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setBusy('refund');
    try {
      await refundOrder(api, id, toRefundBody(refund));
      setRefund(emptyRefundForm());
      setConfirming(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const items = order?.items ?? [];
  const events = order?.events ?? [];

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">订单详情</h1>
        <button type="button" className="link" onClick={onBack}>
          返回列表
        </button>
      </header>

      {loading && <p className="muted">加载中…</p>}
      {error !== '' && <p className="error">{error}</p>}

      {order !== null && (
        <>
          <div className="row2">
            <div className="field">
              <span className="label">订单号</span>
              <span>{order.order_no ?? '—'}</span>
            </div>
            <div className="field">
              <span className="label">状态</span>
              <span>{order.status ?? '—'}</span>
            </div>
            <div className="field">
              <span className="label">合计</span>
              <span>{moneyText(order.total_jpy)}</span>
            </div>
            <div className="field">
              <span className="label">下单时间（JST）</span>
              <span>{formatJst(order.created_at)}</span>
            </div>
          </div>

          <div className="field">
            <span className="label">收货地址</span>
            <span>{addressSummary(order)}</span>
          </div>

          <div className="field">
            <span className="label">商品</span>
            {items.length === 0 ? (
              <span className="muted">—</span>
            ) : (
              <table className="table">
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td>{String(it['title'] ?? '')}</td>
                      <td>× {String(it['qty'] ?? '')}</td>
                      <td>{moneyText(it['unit_price_jpy'])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {paymentSummary(order) !== '—' && (
            <div className="field">
              <span className="label">支付</span>
              <span className="muted">{paymentSummary(order)}</span>
            </div>
          )}

          {events.length > 0 && (
            <div className="field">
              <span className="label">事件</span>
              {events.map((e, i) => (
                <span className="muted" key={i}>
                  {formatJst(e.at)} {e.status ?? ''} {e.note ?? ''}
                </span>
              ))}
            </div>
          )}

          <OrderAddressForm
            api={api}
            id={id}
            order={order}
            onDone={() => {
              void load();
              onChanged();
            }}
          />

          {order.has_dispute === true && (
            <p className="error">
              ⚠️ 该订单有进行中的拒付：退款会被拒（40907），发货前请先处理拒付
            </p>
          )}

          <div className="form">
            <span className="label">发货</span>
            <div className="row2">
              <input
                className="input"
                placeholder="承运商（如 Japan Post）"
                value={ship.carrier}
                onChange={(e) => setShip((s) => ({ ...s, carrier: e.target.value }))}
              />
              <input
                className="input"
                placeholder="运单号"
                value={ship.trackingNo}
                onChange={(e) => setShip((s) => ({ ...s, trackingNo: e.target.value }))}
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={!shipG.ok || busy !== ''}
              onClick={() => void doShip()}
            >
              {busy === 'ship' ? '提交中…' : '确认发货'}
            </button>
            {!shipG.ok && <p className="muted">{shipG.reason}</p>}
          </div>

          <div className="form">
            <span className="label">全额退款（原币退，不可撤销）</span>
            <input
              className="input"
              placeholder="退款原因（进审计台账）"
              value={refund.reason}
              onChange={(e) => setRefund({ reason: e.target.value })}
            />
            {confirming ? (
              <div className="row2">
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== ''}
                  onClick={() => void doRefund()}
                >
                  {busy === 'refund' ? '提交中…' : '确认退款'}
                </button>
                <button type="button" className="link" onClick={() => setConfirming(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!refundG.ok}
                onClick={() => setConfirming(true)}
              >
                退款
              </button>
            )}
            {!refundG.ok && <p className="muted">{refundG.reason}</p>}
          </div>
        </>
      )}
    </section>
  );
}
