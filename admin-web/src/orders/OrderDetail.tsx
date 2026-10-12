/**
 * 职责：订单详情页——左栏读（基本信息 → 商品 → 支付 → 时间线），右栏写（操作条 + 只读的邮箱 / 地址 / 风险）。
 *
 * @why **打开详情时重新拉一次单条**（`GET /admin/orders/{id}`）而不是只用列表带过来的数据：
 *      列表给的是**摘要**（没有 `items` / `address` / `payments` / `events`），
 *      且是打开页面那一刻的快照，期间订单可能已被别人改过（两个客服同时看一单）。
 *
 * @why 写操作**不在本文件**（AJ-398）：六个动作（发货 / 全额退款 / 部分退款 / 解除拒付 / 改址 / 修正）
 *      收进 `OrderActions` 的按钮条，点开在抽屉里填表；本页只负责取数、渲染与把 `load` 交给它们。
 *      闸门、两步确认、Toast 文案都随表单搬走，逻辑未改（@see ./ShipForm.tsx 等文件头）。
 *
 * @limitation 一：写操作成功后**刷新整页详情**而不是本地改状态——状态迁移的结果由服务端决定，
 *              前端猜一个"已退款"会出现"页面说退了、实际还在处理"。
 * @limitation 二：本页**没有自己的 error / notice state**，一律走 `ui/Toast`（第一批①）。
 *              代价是"取详情失败"只在右下角提示，页面只剩订单骨架；由 `ToastStack` 的 sticky 兜住。
 *
 * @see ./OrderActions.tsx；./view.ts（闸门与文案）；./api.ts；../../../contracts/api-contract.yaml（AdminOrder）
 */
import { useCallback, useEffect, useState } from 'react';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { getOrder, type AdminApi, type AdminOrderLike } from './api.js';
import { formatJst, moneyText } from '../format.js';
import { OrderActions } from './OrderActions.js';
import { OrderItems } from './OrderItems.js';
import { OrderTimeline } from './OrderTimeline.js';
import { useChannelLabels } from './channel-labels.js';
import { OrderCustomerCard } from './OrderCustomerCard.js';
import { AfterSales } from './AfterSales.js';
import { Badge } from '../ui/badge.js';
import { detailBadges } from './badges.js';
import {
  addressHistoryRows,
  addressSummary,
  amountBreakdown,
  isDisputeLocked,
  logisticsView,
  paymentSummary,
  statusText,
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
  // 全入口点击测试 2026-10-11：支付通道写中文名（取设置接口，不在前端写死通道名）
  const channelLabels = useChannelLabels(api);
  const [order, setOrder] = useState<AdminOrderLike | null>(source);
  const [loading, setLoading] = useState(true);
  /** 统一反馈出口（第一批①：@see @limitation 三）。 */
  const sink = useToasts();

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

  const items = order?.items ?? [];
  const events = order?.events ?? [];

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">订单详情</h1>
        {/* AJ-400：支付 / 履约 / 拒付 / 测试单 各一枚徽章（口径见 badges.ts），一眼看出"钱扣了没、货发了没" */}
        {order !== null && (
          <span aria-label="订单状态徽章">
            {detailBadges(order).map((b) => (
              <Badge key={b.text} tone={b.tone}>
                {b.text}
              </Badge>
            ))}
          </span>
        )}
        <button type="button" className="link" onClick={onBack}>
          返回列表
        </button>
      </header>

      {loading && <p className="muted">加载中…</p>}
      {/* G7（AJ-467）：取不到这张单时给空态与出口——此前只剩标题 + 右下角 toast，关掉就是一片空白 */}
      {!loading && order === null && (
        <p className="muted">
          找不到这张订单（链接可能有误，或订单已不存在）。
          <button type="button" className="link" onClick={onBack}>
            返回列表
          </button>
        </p>
      )}
      {/* 第一批①：反馈统一走右下角 Toast（@see @limitation 二）。抽屉里的表单也走这一个出口 */}
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />

      {order !== null && (
        <>
          {/*
            第一批④：**双栏**（对标 §4.2）。左栏读（基本信息 → 商品 → 支付 → 时间线），
            右栏写：操作按钮条（点开是抽屉，AJ-398）+ 只读的联系邮箱 / 收货地址 / 风险状态。
            @why 修订前是单列长页，一张单要滚三屏，"发货"和"取消"挨着、误触面大。
            @limitation 窄屏（≤ 60rem）塌回单列：双栏在小屏上会把商品表压成两三个字宽。
          */}
          <div className="detail-grid">
            <div className="detail-main">
              <div className="row2">
                <div className="field">
                  <span className="label">订单号</span>
                  <span className="mono">{order.order_no ?? '—'}</span>
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
                  <span className="label">下单时间（日本时间）</span>
                  <span>{formatJst(order.created_at)}</span>
                </div>
              </div>

              <OrderItems items={items} />

              {/* A-9（AJ-467）：金额拆分——客服回答"退了多少 / 运费多少"原先要去翻时间线 */}
              <div className="row2">
                {amountBreakdown(order).map((line) => (
                  <div className="field" key={line.label}>
                    <span className="label">{line.label}</span>
                    <span>{line.value}</span>
                  </div>
                ))}
              </div>

              {paymentSummary(order, channelLabels) !== '—' && (
                <div className="field">
                  <span className="label">支付</span>
                  <span className="muted">{paymentSummary(order, channelLabels)}</span>
                </div>
              )}

              {/* A-9（AJ-467）：物流块——运单号此前只在时间线备注里 */}
              {logisticsView(order) !== null && (
                <div className="field">
                  <span className="label">物流</span>
                  <span>
                    {logisticsView(order)?.text}
                    {logisticsView(order)?.url !== '' && (
                      <>
                        {' '}
                        <a
                          className="link"
                          href={logisticsView(order)?.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查件
                        </a>
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* 售后申请（AJ-420）：买家在小程序提交；没有申请时整块不渲染。放在时间线之前：进行中的申请是"待办" */}
              <AfterSales
                api={api}
                orderId={id}
                order={order}
                reload={load}
                onError={(text, traceId) => sink.error(text, { traceId })}
                onSuccess={(text) => sink.success(text)}
              />

              {/* 时间线（第一批⑤，AJ-396）：系统事件与内部备注按时间混排，底部追加备注。
                取数与提交在 OrderTimeline 里，不随详情刷新（备注 append-only，追加后就地并入） */}
              <OrderTimeline
                api={api}
                orderId={id}
                events={events}
                onError={(text, traceId) => sink.error(text, { traceId })}
                onSuccess={(text) => sink.success(text)}
                channelLabels={channelLabels}
              />

              {/* 扫描 A-03：运营日志按"对象 id"查的是内部 id（ord-…），按订单号查永远"没有记录"——所以仍要给出。
                AJ-410 / N14：但它是给技术人员的，一长串乱码放在订单号旁边会让新手以为是另一个单号——收进页底折叠的「技术信息」。 */}
              <details className="tech-info">
                <summary>技术信息</summary>
                <span className="muted">
                  内部编号（技术人员查操作日志用）：
                  <span className="selectable">{order.order_id ?? '—'}</span>
                </span>
              </details>
            </div>
            {/* ← 主区结束：基本信息 → 商品 → 支付 → 时间线 */}

            <aside className="detail-actions">
              {/* 写操作：按钮条 + 抽屉（AJ-398）。放在右栏最上面：打开详情第一眼就知道"能对它做什么" */}
              <OrderActions
                api={api}
                id={id}
                order={order}
                sink={sink}
                reload={load}
                onChanged={onChanged}
              />

              {/* 以下全是只读：客户 / 联系邮箱 / 收货地址 / 风险状态 */}
              {/* 客户卡片（AJ-404，§4.2 第 168 行）：历史单数 + 累计付款（不扣退款）+ 进客户页 */}
              <OrderCustomerCard order={order} />
              {/* 联系邮箱（三端联动 UI 模拟 2026-10-08：客服要联系买家时原先只能去库里查） */}
              <div className="field">
                <span className="label">联系邮箱</span>
                <span className="selectable">
                  {typeof (order as { contact_email?: unknown }).contact_email === 'string'
                    ? String((order as { contact_email?: unknown }).contact_email)
                    : '买家未留邮箱'}
                </span>
              </div>

              <div className="field">
                <span className="label">收货地址</span>
                <span>{addressSummary(order)}</span>
              </div>
              {/* A-4（AJ-467）：改址历史——此前只有写入没有读取，成功提示却说"可在事件里查" */}
              {addressHistoryRows(order).length > 0 && (
                <div className="field">
                  <span className="label">改址历史</span>
                  <span className="muted">
                    {addressHistoryRows(order).map((h) => (
                      <span key={h.id} className="timeline-note-body">
                        {h.atText} 改前：{h.text}
                        {h.actor !== '' ? `（${h.actor}）` : ''}
                        <br />
                      </span>
                    ))}
                  </span>
                </div>
              )}

              <div className="field">
                <span className="label">风险状态</span>
                <span className={isDisputeLocked(order) ? 'error' : 'muted'}>
                  {isDisputeLocked(order)
                    ? '有进行中的拒付：退款与发货已锁（可在「解除拒付限制…」人工解除）'
                    : '无进行中的拒付'}
                </span>
              </div>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
