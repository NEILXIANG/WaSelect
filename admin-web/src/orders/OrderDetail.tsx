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
 * @why 发货与退款都是**两步确认**而不是一次性提交：
 *      退款是钱出去的动作，且 MVP 只支持全额退款、没有"撤销"。
 *      ⚠️ 二次确认不能替代闸门——它只防误点，不防"这单本来就不该退"。
 *      第一批①（2026-10-08）起两步确认统一走 `ui/ConfirmDialog`，
 *      发货另要求**重打一遍运单号**（运单号是从邮件里复制来的，看一遍看不出首尾错字）。
 *
 * @limitation 一：**改址不在这里**（`OrderAddressForm` 单独一个组件接进来），
 *              它要七个美式地址字段，塞进本页会把详情挤成两屏。
 * @limitation 二：发货 / 退款成功后**刷新整页详情**而不是本地改状态——
 *              状态迁移的结果（refunding → refunded）由服务端决定，
 *              前端猜一个"已退款"会出现"页面说退了、实际还在处理"。
 * @limitation 三：本页**不再有自己的 error / notice state**，一律走 `ui/Toast`
 *              （第一批①）：此前提示渲染在页面顶部，而退款按钮在第四段表单，
 *              点完往下看根本不知道成了没成。⚠️ 代价是"取详情失败"也从页面里消失了——
 *              失败时页面只剩订单骨架，提示在右下角；这一条由 `ToastStack` 的 sticky 兜住。
 *
 * @see ./view.ts（闸门与请求体）；./api.ts；../../../contracts/api-contract.yaml（AdminOrder）
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { ADMIN_NOTE_MAX_LENGTH, REFUND_REASON_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';
import { ApiError, retryAfterMsSec } from '../api/errors.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
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
import { OrderTimeline } from './OrderTimeline.js';
import { TRACKING_SHAPE_WARNING, trackingWarning } from './fix-view.js';
import { trackingNoRecognized } from '@waselect/shared';
import {
  addressSummary,
  emptyRefundForm,
  emptyReleaseForm,
  emptyShipForm,
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

/** 行项目首图的 thumb（只收 http(s)；三端联动 UI 模拟 2026-10-08）。 */
function itemThumb(it: Record<string, unknown>): string {
  const t = (it['image'] as { thumb?: unknown } | undefined)?.thumb;
  return typeof t === 'string' && /^https?:\/\//.test(t) ? t : '';
}

export function OrderDetail({ api, id, source, onBack, onChanged }: OrderDetailProps) {
  const [order, setOrder] = useState<AdminOrderLike | null>(source);
  const [loading, setLoading] = useState(true);
  /** 统一反馈出口（第一批①：@see @limitation 三）。 */
  const sink = useToasts();
  const [ship, setShip] = useState(emptyShipForm);
  /**
   * 是否已点过「发货」：行内错误只在这之后显示。
   * @why 一进页面就报红（不判断是否 touched）会让空表单像"已经坏了"，
   *      而发货表单本来就是空的——那是初始状态，不是错误状态。
   */
  const [shipTouched, setShipTouched] = useState(false);
  const [refund, setRefund] = useState(emptyRefundForm);
  /** 解除拒付限制的表单（B1b / AJ-194；不可逆，契约没有"重新上锁"）。 */
  const [release, setRelease] = useState(emptyReleaseForm);
  /** 未保存离开提醒（第一批⑥ 补齐到订单页）：三份草稿任一非空即算脏；成功后各自 reset 回空，脏态自然消失。 */
  useFormDirty(
    { ship, refund, release },
    { ship: emptyShipForm(), refund: emptyRefundForm(), release: emptyReleaseForm() },
  );
  const [busy, setBusy] = useState('');
  /**
   * 当前打开的确认弹层（null = 没开）。发货 / 退款 / 解除拒付**共用一个出口**。
   * @why 三个动作各留一份 `xxxConfirming` 时，"同时打开两个"在类型上不可能、
   *      但"上一个没收干净就开下一个"在运行时可能（退款失败后立刻点发货）；
   *      一个出口让"开着的时候别的动作进不来"成为结构性事实，而不是靠记得去清理。
   */
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  /**
   * 弹层确认后要跑的动作。
   * @why 用 ref 而不是把它塞进 `dialog` 的 state：**函数进 state 会被 React 当成 updater**
   *      （`setDialog(fn)` 直接把 fn 当 `(prev) => next` 调用）——这类错误不报错，
   *      表现为"点完确认什么都没发生"。分开存就从根上没有这个坑。
   */
  const dialogRun = useRef<() => void>(() => undefined);

  /** 打开确认弹层：先声明后果（spec），再声明确认后跑什么（run）。 */
  const ask = useCallback((spec: ConfirmSpec, run: () => void): void => {
    dialogRun.current = run;
    setDialog(spec);
  }, []);

  /** 取详情；返回取到的订单（失败为 null），供"出错后按真实状态说话"使用（P2-49）。 */
  const load = useCallback(async (): Promise<AdminOrderLike | null> => {
    setLoading(true);
    try {
      const fresh = await getOrder(api, id);
      setOrder(fresh);
      return fresh;
    } catch (e) {
      // ⚠️ 取详情失败**不清空已有数据**：留着上一次的列表面也比整页空白好排查
      const { text, traceId } = toastError(e, '取订单详情失败');
      sink.error(text, { traceId });
      return null;
    } finally {
      setLoading(false);
    }
  }, [api, id, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const shipG = shipGate(order);
  const refundG = refundGate(order);

  const shipCheck = shipErrors(ship);

  const doShip = async (): Promise<void> => {
    if (!shipCheck.ok) {
      sink.error(shipCheck.summary);
      setDialog(null);
      return;
    }
    setBusy('ship');
    try {
      const resp = await shipOrder(api, id, toShipBody(ship));
      setShip(emptyShipForm());
      setDialog(null);
      await load();
      onChanged();
      // P1-10：服务端认不出运单号形状时提醒核对（已保存；录错可在「订单修正」里改）
      const warn = trackingWarning(resp);
      if (warn !== '') sink.info(warn, { sticky: true });
      else sink.success('已发货，运单号已随发货邮件发给买家');
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, '发货失败');
      sink.error(text, { traceId });
    } finally {
      setBusy('');
    }
  };

  const askShip = (): void => {
    // 点了才算" touched "：第一次打开页面就红一片会让人以为输入框里有脏东西
    setShipTouched(true);
    if (!shipCheck.ok) {
      // ⚠️ 用 summary（全部缺失项），不用 first：一次说完，不让运营走"改一个、再点、再改一个"
      sink.error(shipCheck.summary);
      return;
    }
    ask(
      {
        title: '发货后不能再改址，运单号录错只能走「订单修正」',
        body: `承运商 ${ship.carrier.trim()} / 运单号 ${ship.trackingNo.trim()}。确认后发货邮件立即发给买家。`,
        confirmText: '确认发货',
        danger: true,
        // 运单号是从承运商邮件里复制来的，看一遍看不出首尾错字——手打一遍才能发现
        typeToConfirm: ship.trackingNo.trim(),
        typeLabel: '请再输入一次运单号（复制来的单号最容易错在首尾字符）',
      },
      () => void doShip(),
    );
  };

  const askRefund = (): void => {
    const check = refundErrors(refund);
    if (!check.ok) {
      sink.error(check.first);
      return;
    }
    ask(
      {
        title: '全额退款：原币退，不可撤销',
        body: `订单 ${order?.order_no ?? id}，合计 ${moneyText(order?.total_jpy)}。退款原因会进审计台账。`,
        confirmText: '确认退款',
        danger: true,
      },
      () => void doRefund(),
    );
  };

  const doRefund = async (): Promise<void> => {
    const check = refundErrors(refund);
    if (!check.ok) {
      sink.error(check.first);
      setDialog(null);
      return;
    }
    setBusy('refund');
    try {
      const outcome = await refundOrder(api, id, toRefundBody(refund));
      setRefund(emptyRefundForm());
      setDialog(null);
      // ⚠️ 三种 outcome 必须分别说（B41 / AJ-215）：把它们一律当成"提交成功"的话，
      //    `pending`（机构处理中）在界面上等于"什么都没发生"，运营会去 Stripe 后台手工退
      //    ——同一笔钱退两次，且机构侧第二次很可能真的成功。
      //    ⚠️ 后两档给 **sticky**：它们写的是"下一步怎么办"，3 秒后消失等于没说。
      if (outcome === 'succeeded') sink.success('退款已完成（机构已确认），订单状态已更新');
      else if (outcome === 'pending')
        sink.info(
          '已提交机构，处理中：订单保持在「退款中」。稍后可再提交一次查询最新结果（不会重复退款）',
          { sticky: true },
        );
      else
        sink.info('已提交，但响应里没有确认结果：请刷新详情核对订单状态，不要重复提交', {
          sticky: true,
        });
      await load();
      onChanged();
    } catch (e) {
      // ⚠️ 出错 ≠ 没退（B41 残留 / AJ-230）：服务端先落 `refunding` 再调机构，
      //    机构超时 / 网络断开时订单很可能已经变了。所以这里**先重新取详情**，
      //    再把错误与"结果未知"的提醒摆出来；弹层关掉，不留一个还能再点的"确认退款"。
      const message = e instanceof ApiError ? e.message : String(e);
      const code = e instanceof ApiError ? e.code : 0;
      const traceId = e instanceof ApiError ? e.traceId : undefined;
      setDialog(null);
      const fresh = await load();
      onChanged();
      sink.error(message, { traceId });
      // 按刷新后的真实状态说话（P2-49）：已退成 / 机构确认失败 / 结果未知 / 50300 未发出，四种下一步各不相同
      sink.info(fullRefundErrorNotice({ code, retryAfterSec: retryAfterMsSec(e), order: fresh }), {
        sticky: true,
      });
    } finally {
      setBusy('');
    }
  };

  const doRelease = async (): Promise<void> => {
    const check = releaseErrors(release);
    if (!check.ok) {
      sink.error(check.first);
      setDialog(null);
      return;
    }
    setBusy('release');
    try {
      await releaseDisputeHold(api, id, toReleaseBody(release));
      setRelease(emptyReleaseForm());
      setDialog(null);
      // ⚠️ 这句不是"成功了"的确认，是**警告**（@see view.ts RELEASE_DONE_NOTICE）：
      //    拒付本身没有结案，而发货闸门恰恰在这一刻打开了。所以给 sticky——
      //    让它自动消失的话，运营只记得"解除成功了"，不记得"这单还能发货要小心"。
      sink.info(RELEASE_DONE_NOTICE, { sticky: true });
      await load();
      onChanged();
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, '解除拒付限制失败');
      sink.error(text, { traceId });
    } finally {
      setBusy('');
    }
  };

  const askRelease = (): void => {
    const check = releaseErrors(release);
    if (!check.ok) {
      sink.error(check.first);
      return;
    }
    ask(
      {
        title: '解除后发货闸门立即打开，且不可撤销',
        body: '拒付本身不会结案：`payments.dispute_*` 一个字都不会改，这条拒付仍留在风控列表，机构仍可能判败诉并把钱收回。确认后这张单可以被发货、被退款。',
        confirmText: '确认解除（不可撤销）',
        danger: true,
      },
      () => void doRelease(),
    );
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
      {/*
        第一批①：反馈统一走右下角 Toast。
        @why 不再渲染在页面顶部——退款按钮在本页第四段表单，点完往下看根本不知道成了没成；
             而"提示在顶部"这件事此前是逐页手写的，新页面照样会漏（@see @limitation 三）。
      */}
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />

      {order !== null && (
        <>
          {/*
            第一批④：**双栏**（对标 §4.2）。主区（基本信息 → 商品 → 支付 → 时间线）自上而下读，
            右栏收着"看一眼就要用"的东西：收货地址 + 改址入口、联系邮箱、风险状态，以及**所有写操作**。
            @why 修订前是单列长页：表单按 基本信息→地址→商品→支付→事件→改址→发货→退款→部分退款→修正 堆成一列，
                 一张单要滚三屏；而"发货"和"取消"在视觉上挨着、只差几十像素，误触面大。
            @why 操作放**右栏**而不是继续留在主区："读"和"写"分成两块，让眼睛知道
                 左边是"这张单是什么样"，右边是"我能对它做什么"（Shopify / 有赞 / 抖店同一格局）。
            @limitation 窄屏（≤ 60rem）塌回单列：双栏在小屏上会把商品表压成两三个字宽。
          */}
          <div className="detail-grid">
            <div className="detail-main">
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
                            <td>
                              {itemThumb(it) !== '' && (
                                <img className="thumb" src={itemThumb(it)} alt="" loading="lazy" />
                              )}{' '}
                              {String(it['title'] ?? '')}
                            </td>
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

              {/* 时间线（第一批⑤，AJ-396）：系统事件与内部备注按时间混排，底部追加备注。
                取数与提交在 OrderTimeline 里，不随详情刷新（备注 append-only，追加后就地并入） */}
              <OrderTimeline
                api={api}
                orderId={id}
                events={events}
                onError={(text, traceId) => sink.error(text, { traceId })}
                onSuccess={(text) => sink.success(text)}
              />
            </div>
            {/* ← 主区结束：基本信息 → 商品 → 支付 → 时间线 */}

            <aside className="detail-actions">
              {/* 联系邮箱（三端联动 UI 模拟 2026-10-08：客服要联系买家时原先只能去库里查） */}
              <div className="field">
                <span className="label">联系邮箱</span>
                <span className="selectable">
                  {typeof (order as { contact_email?: unknown }).contact_email === 'string'
                    ? String((order as { contact_email?: unknown }).contact_email)
                    : '买家未留邮箱'}
                </span>
              </div>

              {/* key 随地址变化（A-02）：首帧用的是列表快照（没有 address），表单的初值只在挂载时取；
                详情带着地址回来、或改址保存后地址变了，都要重新挂载一次才会预填当前地址。 */}
              <OrderAddressForm
                key={JSON.stringify((order as { address?: unknown }).address ?? null)}
                api={api}
                id={id}
                order={order}
                onDone={(message) => {
                  void load().then(() => sink.success(message));
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
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy !== ''}
                    onClick={askRelease}
                  >
                    人工解除拒付限制
                  </button>
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
                    className={`input${shipTouched && shipCheck.errors['carrier'] ? ' input-error' : ''}`}
                    placeholder="承运商（如 Japan Post）"
                    maxLength={SHIP_MAX_CHARS.carrier}
                    value={ship.carrier}
                    aria-invalid={shipTouched && shipCheck.errors['carrier'] !== undefined}
                    onChange={(e) => setShip((s) => ({ ...s, carrier: e.target.value }))}
                  />
                  <input
                    className={`input${shipTouched && shipCheck.errors['trackingNo'] ? ' input-error' : ''}`}
                    placeholder="运单号"
                    maxLength={SHIP_MAX_CHARS.tracking_no}
                    value={ship.trackingNo}
                    aria-invalid={shipTouched && shipCheck.errors['trackingNo'] !== undefined}
                    onChange={(e) => setShip((s) => ({ ...s, trackingNo: e.target.value }))}
                  />
                </div>
                {/*
            行内错误（三端联动模拟 2026-10-08 实测缺陷）：
            修订前两个字段都空时只弹一条 Toast「承运商必填」，且 Toast 在页面右上角、
            与发货按钮相距约 960px 的对角——运营看见红条时视线已经离开表单，
            改完一个还得回来再点一次才知道还差一个。现在缺哪项就红在哪一项下面。
          */}
                {shipTouched && (
                  <div className="field-errors" role="alert">
                    {Object.entries(shipCheck.errors).map(([k, msg]) => (
                      <span key={k} className="error">
                        {msg}
                      </span>
                    ))}
                  </div>
                )}
                {/* 确认**之前**就提示（三端联动模拟 2026-10-08）：发货邮件随确认一起发出，事后提示已晚。
                弹层里也会再显示一次承运商 / 运单号，并要求重打运单号。 */}
                {ship.trackingNo.trim() !== '' &&
                  !trackingNoRecognized(ship.carrier, ship.trackingNo) && (
                    <span className="error">{TRACKING_SHAPE_WARNING}</span>
                  )}
                <button
                  type="button"
                  className="btn"
                  disabled={!shipG.ok || busy !== ''}
                  onClick={askShip}
                >
                  发货
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
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!refundG.ok || busy !== ''}
                  onClick={askRefund}
                >
                  退款
                </button>
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
                onError={(m) => sink.error(m)}
                onNotice={(m) => sink.info(m)}
                // ⚠️ 成功单独一条通道：Toast 的清屏挂在 kind === 'success' 上，
                //    走 info 的话上一次失败的错误条会留着，屏幕上红绿各一条
                onSuccess={(m) => sink.success(m)}
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
                onError={(m) => sink.error(m)}
                onNotice={(m) => sink.info(m)}
              />
            </aside>
          </div>
        </>
      )}

      {/*
        三个动作的确认出口（第一批①）。
        @why 放在 `order !== null` 的**外面**：取详情失败时 `dialog` 理论上开不出来
             （按钮都不在里面），但把它留在这里，将来把动作移到骨架区也不会漏渲染。
      */}
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy !== ''}
          onConfirm={() => dialogRun.current()}
          onCancel={() => setDialog(null)}
        />
      )}
    </section>
  );
}
