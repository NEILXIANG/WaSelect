/**
 * 职责：订单详情 + 三个不可逆动作（发货 / 退款 / **解除拒付限制**）。
 *
 * @why 第三个动作（B1b / AJ-194）是**逃生口**，不是常规操作：
 *      `has_dispute` 一旦为 true，发货与退款就都被锁，而能让它变回 false 的
 *      正常路径只有一条——机构发来 `charge.dispute.closed`。那条链会断在任何一环
 *      （机构漏发、我们当时没接住、未知状态被拒落库、败诉单后来与买家协商好了），
 *      断了之后的终点是"订单永久锁死，唯一解法是直连数据库改行"——既不留痕也不可复核。
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
import { ADMIN_NOTE_MAX_LENGTH, REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import {
  getOrder,
  refundOrder,
  releaseDisputeHold,
  shipOrder,
  type AdminApi,
  type AdminOrderLike,
} from './api.js';
import { formatJst, moneyText } from '../format.js';
import { OrderAddressForm } from './OrderAddressForm.js';
import {
  addressSummary,
  emptyRefundForm,
  emptyReleaseForm,
  emptyShipForm,
  paymentSummary,
  refundErrors,
  refundFailureNotice,
  refundGate,
  RELEASE_DONE_NOTICE,
  releaseErrors,
  isDisputeLocked,
  shipErrors,
  shipGate,
  toRefundBody,
  toReleaseBody,
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
  /**
   * 信息性提示（不是错误）：退款提交后的 `outcome` 由这里说清楚（B41 / AJ-215）。
   * @why 与 `error` 分开：`error` 的样式是红色的，把"机构处理中"显示成红色
   *      会让运营当成失败——**正是 B41 要防的事**（他会转去 Stripe 后台手工退同一笔）。
   */
  const [notice, setNotice] = useState('');
  const [ship, setShip] = useState(emptyShipForm);
  const [refund, setRefund] = useState(emptyRefundForm);
  /** 退款的两步确认（null = 未发起）。 */
  const [confirming, setConfirming] = useState(false);
  /** 解除拒付限制的表单与两步确认（B1b / AJ-194；不可逆，契约没有"重新上锁"）。 */
  const [release, setRelease] = useState(emptyReleaseForm);
  const [releaseConfirming, setReleaseConfirming] = useState(false);
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
    setNotice('');
    try {
      const outcome = await refundOrder(api, id, toRefundBody(refund));
      setRefund(emptyRefundForm());
      setConfirming(false);
      // ⚠️ 三种 outcome 必须分别说（B41 / AJ-215）：把它们一律当成"提交成功"的话，
      //    `pending`（机构处理中）在界面上等于"什么都没发生"，运营会去 Stripe 后台手工退
      //    ——同一笔钱退两次，且机构侧第二次很可能真的成功。
      if (outcome === 'succeeded') setNotice('退款已完成（机构已确认），订单状态已更新');
      else if (outcome === 'pending')
        setNotice(
          '已提交机构，处理中：订单保持在「退款中」。稍后可再提交一次查询最新结果（不会重复退款）',
        );
      else setNotice('已提交，但响应里没有确认结果：请刷新详情核对订单状态，不要重复提交');
      await load();
      onChanged();
    } catch (e) {
      // ⚠️ 出错 ≠ 没退（B41 残留 / AJ-230）：服务端先落 `refunding` 再调机构，
      //    机构超时 / 网络断开时订单很可能已经变了。所以这里**先重新取详情**（`load` 开头会清 error，
      //    顺序不能反），再把错误与"结果未知"的提醒摆出来；确认态退出，不留一个还能再点的"确认退款"。
      const message = e instanceof ApiError ? e.message : String(e);
      const code = e instanceof ApiError ? e.code : 0;
      setConfirming(false);
      await load();
      onChanged();
      setError(message);
      setNotice(refundFailureNotice(code));
    } finally {
      setBusy('');
    }
  };

  const doRelease = async (): Promise<void> => {
    const check = releaseErrors(release);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setBusy('release');
    setNotice('');
    try {
      await releaseDisputeHold(api, id, toReleaseBody(release));
      setRelease(emptyReleaseForm());
      setReleaseConfirming(false);
      // ⚠️ 这句不是"成功了"的确认，是**警告**（@see view.ts RELEASE_DONE_NOTICE）：
      //    拒付本身没有结案，而发货闸门恰恰在这一刻打开了。
      setNotice(RELEASE_DONE_NOTICE);
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
      {/* 提在页面级：退款的 outcome 与"解除拒付限制"的警告都要能被看见，
          放在某一个表单里的话，另一个动作的结果会被藏在折叠块里。 */}
      {notice !== '' && <p className="muted">{notice}</p>}

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

          {isDisputeLocked(order) && (
            <div className="form">
              <span className="label">拒付限制（退款 40907 / 发货被拦）</span>
              <p className="error">
                ⚠️ 该订单有进行中的拒付：退款会被拒（40907），发货也会拦住（发货后钱货两空）。
                若拒付链已断——机构漏发结案事件、或已与买家协商和好、或败诉单另作处置——
                可在这里人工解除限制。
              </p>
              <input
                className="input"
                placeholder="解除理由（进审计台账与订单时间线）"
                // 硬上限来自 shared（与服务端同一个常量，AJ-291）
                maxLength={ADMIN_NOTE_MAX_LENGTH}
                value={release.reason}
                onChange={(e) => setRelease({ reason: e.target.value })}
              />
              {releaseConfirming ? (
                <div className="row2">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== ''}
                    onClick={() => void doRelease()}
                  >
                    {busy === 'release' ? '提交中…' : '确认解除（不可撤销）'}
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setReleaseConfirming(false)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== ''}
                  onClick={() => setReleaseConfirming(true)}
                >
                  人工解除拒付限制
                </button>
              )}
              <p className="muted">
                解除的是「限制」不是「事实」：`payments.dispute_*` 一个字都不会改，
                这条拒付仍留在风控列表，机构仍可能判败诉并把钱收回。
              </p>
            </div>
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
              // 硬上限来自 shared（B7 / AJ-191）：超长会被机构拒且订单卡在退款中
              maxLength={REFUND_REASON_MAX_LENGTH}
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
            {/* 放行时也可能带提示（refunding = 再查询/重发，KD-12）：有话就显示，不只在拦的时候 */}
            {refundG.reason !== '' && <p className="muted">{refundG.reason}</p>}
          </div>
        </>
      )}
    </section>
  );
}
