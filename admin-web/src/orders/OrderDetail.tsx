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
 * @why 发货与退款都是**两步确认**（点「发货」/「退款」→ 出现「确认… / 取消」；发货于 P2-51 补）而不是一次性提交：
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
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH, REFUND_REASON_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';
import { ApiError, retryAfterMsSec } from '../api/errors.js';
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
import { PartialRefunds } from './PartialRefunds.js';
import { OrderFixActions } from './OrderFixActions.js';
import { TRACKING_SHAPE_WARNING, trackingWarning } from './fix-view.js';
import { trackingNoRecognized } from '@waselect/shared';
import {
  addressSummary,
  emptyRefundForm,
  emptyReleaseForm,
  emptyShipForm,
  eventStatusText,
  paymentSummary,
  purchaseLine,
  fullRefundErrorNotice,
  refundErrors,
  refundGate,
  RELEASE_DONE_NOTICE,
  releaseErrors,
  isDisputeLocked,
  shipErrors,
  shipGate,
  statusText,
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
  /**
   * 发货的两步确认（P2-51）。
   * @why 发货后订单不能再改址、全额退款也不回补库存，而运单号填错目前只能等服务端加"改运单号"接口；
   *      与退款同口径先点「发货」→ 核对承运商与运单号 → 「确认发货」。改了输入框内容即退出确认态。
   */
  const [shipConfirming, setShipConfirming] = useState(false);
  /** 解除拒付限制的表单与两步确认（B1b / AJ-194；不可逆，契约没有"重新上锁"）。 */
  const [release, setRelease] = useState(emptyReleaseForm);
  const [releaseConfirming, setReleaseConfirming] = useState(false);
  const [busy, setBusy] = useState('');

  /** 取详情；返回取到的订单（失败为 null），供"出错后按真实状态说话"使用（P2-49）。 */
  const load = useCallback(async (): Promise<AdminOrderLike | null> => {
    setLoading(true);
    setError('');
    try {
      const fresh = await getOrder(api, id);
      setOrder(fresh);
      return fresh;
    } catch (e) {
      // ⚠️ 取详情失败**不清空已有数据**：留着上一次的列表面也比整页空白好排查
      setError(e instanceof ApiError ? e.message : String(e));
      return null;
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
    setNotice('');
    try {
      const resp = await shipOrder(api, id, toShipBody(ship));
      setShip(emptyShipForm());
      setShipConfirming(false);
      await load();
      onChanged();
      // P1-10：服务端认不出运单号形状时提醒核对（已保存；录错可在「订单修正」里改）
      const warn = trackingWarning(resp);
      if (warn !== '') setNotice(warn);
    } catch (e) {
      setShipConfirming(false);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const askShip = (): void => {
    const check = shipErrors(ship);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setError('');
    setShipConfirming(true);
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
      const fresh = await load();
      onChanged();
      setError(message);
      // 按刷新后的真实状态说话（P2-49）：已退成 / 机构确认失败 / 结果未知 / 50300 未发出，四种下一步各不相同
      setNotice(fullRefundErrorNotice({ code, retryAfterSec: retryAfterMsSec(e), order: fresh }));
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
            {/* 扫描 A-03：运营日志按"对象 id"查的是内部 id（ord-…），列表与详情原来都不显示它，
                按订单号去查永远"没有记录"。这里给出可选中复制的内部 id。 */}
            <div className="field">
              <span className="label">内部 ID（查运营日志用）</span>
              <span className="muted selectable">{order.order_id ?? '—'}</span>
            </div>
            <div className="field">
              <span className="label">状态</span>
              {/* 🔴 走 `statusText` 而不是 `order.status`：直接渲染原文会让这一格显示 `paid`，
                  而同一张单在列表页显示的是「待发货」——两个页面对同一个状态两种叫法，
                  客服照详情页对客户说话时会说成"你那张 paid 的单"。
                  （L4 浏览器验收 2026-10-02 发现；契约外的状态由它统一显示「未知状态」） */}
              <span>{statusText(order)}</span>
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
                    <Fragment key={i}>
                      <tr>
                        <td>{String(it['title'] ?? '')}</td>
                        <td>× {String(it['qty'] ?? '')}</td>
                        <td>{moneyText(it['unit_price_jpy'])}</td>
                      </tr>
                      {/* 采购信息另起一行：它是**执行依据**（照这三样去买），
                          与上面那行"买了什么、多少钱"是两种用途，挤在一行里谁都读不清。
                          走 `purchaseLine` 而不是直接拼字段：缺的字段要显示「未记录」，
                          三样全缺时还要说清"这单建于采购信息录入之前"——
                          省略会让人分不清"商品没有"和"系统没记"。 */}
                      <tr className="row-sub">
                        <td colSpan={3}>{purchaseLine(it)}</td>
                      </tr>
                    </Fragment>
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
                  {/* `eventStatusText` 而不是 `e.status`：事件流里有一半是"没迁状态、
                      只记一件事"的伪状态（改址 / 拒付开案 / 退款失败……）。
                      note 里虽然有中文说明，但"这是什么类别"仍要看 status 才认得出。 */}
                  {formatJst(e.at)} {eventStatusText(e.status)} {e.note ?? ''}
                </span>
              ))}
            </div>
          )}

          {/* key 随地址变化（A-02）：首帧用的是列表快照（没有 address），表单的初值只在挂载时取；
              详情带着地址回来、或改址保存后地址变了，都要重新挂载一次才会预填当前地址。 */}
          <OrderAddressForm
            key={JSON.stringify((order as { address?: unknown }).address ?? null)}
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
              {/* maxLength 引 shared 常量（AJ-315）：与服务端同一个上限，不写第二个 32 / 64 */}
              <input
                className="input"
                placeholder="承运商（如 Japan Post）"
                maxLength={SHIP_MAX_CHARS.carrier}
                value={ship.carrier}
                onChange={(e) => {
                  setShipConfirming(false);
                  setShip((s) => ({ ...s, carrier: e.target.value }));
                }}
              />
              <input
                className="input"
                placeholder="运单号"
                maxLength={SHIP_MAX_CHARS.tracking_no}
                value={ship.trackingNo}
                onChange={(e) => {
                  setShipConfirming(false);
                  setShip((s) => ({ ...s, trackingNo: e.target.value }));
                }}
              />
            </div>
            {shipConfirming ? (
              <div className="row2">
                <span className="muted">
                  核对：{ship.carrier.trim()} / {ship.trackingNo.trim()}
                </span>
                {/* 确认**之前**就提示（三端联动模拟 2026-10-08）：发货邮件随确认一起发出，事后提示已晚 */}
                {!trackingNoRecognized(ship.carrier, ship.trackingNo) && (
                  <span className="error">{TRACKING_SHAPE_WARNING}</span>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={!shipG.ok || busy !== ''}
                  onClick={() => void doShip()}
                >
                  {busy === 'ship' ? '提交中…' : '确认发货'}
                </button>
                <button type="button" className="link" onClick={() => setShipConfirming(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!shipG.ok || busy !== ''}
                onClick={askShip}
              >
                发货
              </button>
            )}
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

          {/* 部分退款 / 完成后售后退款（AJ-383）：订单状态不变；结束后刷新详情与列表 */}
          <PartialRefunds
            api={api}
            orderId={id}
            order={order}
            onDone={async () => {
              const fresh = await load();
              onChanged();
              return fresh;
            }}
            onError={setError}
            onNotice={setNotice}
          />

          {/* 取消未付单 / 改运单号（AJ-386 P1-10 / P1-11）：门槛不满足时整块不渲染 */}
          <OrderFixActions
            api={api}
            orderId={id}
            order={order}
            onDone={async () => {
              await load();
              onChanged();
            }}
            onError={setError}
            onNotice={setNotice}
          />
        </>
      )}
    </section>
  );
}
