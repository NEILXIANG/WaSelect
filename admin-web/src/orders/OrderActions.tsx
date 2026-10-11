/**
 * 职责：订单详情右栏的**操作条**——闸门放行的写操作各一颗按钮，点开在抽屉里填表（对标 §4.2 / §8-1④，AJ-398）。
 *
 * @why 按钮**只在闸门放行时出现**（与拆分前"不可用就不渲染 / 置灰并说明"同口径）：
 *      发货与全额退款这两个主动作被拦时，在操作条下方用一行灰字说清为什么，
 *      不让运营以为"按钮丢了"。其余动作（改址 / 修正 / 解除拒付）不可用时本就不该出现。
 * @why 一次只开一个抽屉：两个写操作同时摊开，正是改版前"发货与取消挨着"的误触面。
 * @why 抽屉里的动作**闸门关了就自动收起**（例如发货成功后状态变 shipped）：
 *      留着一个已经不能用的表单，比关掉它更让人困惑。
 *
 * @limitation 一：部分退款即使额度用完（闸门不放行）、只要有历史记录也给按钮——
 *              记录与「同步」按钮在抽屉里，收起来就看不到在途那一笔了。
 * @limitation 二：改址 / 部分退款 / 订单修正三个组件的提交中状态是内部的，抽屉锁不住它们（@see ../ui/drawer.tsx）。
 * @see ./ShipForm.tsx；./RefundForm.tsx；./ReleaseForm.tsx；./OrderAddressForm.tsx；./PartialRefunds.tsx；./OrderFixActions.tsx
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ActionDrawer } from '../ui/drawer.js';
import type { AdminApi, AdminOrderLike } from './api.js';
import { cancelGate, shipmentFixGate } from './fix-view.js';
import { OrderAddressForm } from './OrderAddressForm.js';
import { staleNotice, type ToastSink } from '../ui/toast.js';
import { OrderFixActions } from './OrderFixActions.js';
import { PartialRefunds } from './PartialRefunds.js';
import { partialRefundGate, partialRefundRows } from './partial-refund-view.js';
import { RefundForm } from './RefundForm.js';
import { ReleaseForm } from './ReleaseForm.js';
import { ShipForm } from './ShipForm.js';
import { addressGate, isDisputeLocked, refundGate, shipGate } from './view.js';

type ActionKey = 'ship' | 'refund' | 'partial' | 'release' | 'address' | 'fix';

/** 按钮文字（「…」= 会打开一个面板，不会立刻执行）与抽屉标题。 */
const ACTIONS: ReadonlyArray<{ key: ActionKey; button: string; title: string }> = [
  { key: 'ship', button: '发货…', title: '发货' },
  { key: 'refund', button: '全额退款…', title: '全额退款（原币退，不可撤销）' },
  { key: 'partial', button: '部分退款…', title: '部分退款 / 售后退款' },
  { key: 'release', button: '解除拒付限制…', title: '解除拒付限制（退款与发货已被锁）' },
  { key: 'address', button: '改址…', title: '发货前改址' },
  { key: 'fix', button: '订单修正…', title: '取消订单 / 修改运单号 / 撤销发货' },
];

/** 当前订单下哪些动作可用（纯函数，闸门全部复用 view / fix-view / partial-refund-view）。 */
export function availableActions(order: AdminOrderLike): Set<ActionKey> {
  const on = new Set<ActionKey>();
  if (shipGate(order).ok) on.add('ship');
  if (refundGate(order).ok) on.add('refund');
  if (partialRefundGate(order).ok || partialRefundRows(order).length > 0) on.add('partial');
  if (isDisputeLocked(order)) on.add('release');
  if (addressGate(order).ok) on.add('address');
  if (cancelGate(order).ok || shipmentFixGate(order).ok) on.add('fix');
  return on;
}

/**
 * 操作条按钮的视觉层级（对标 §238「主按钮每屏只留一个」）。
 * @why 实心只给「发货」——它是唯一"往前推订单"的动作；退款 / 解除拒付是危险入口，用红色描边
 *      （真正执行的实心红按钮在抽屉里，点开后还有一次确认）；改址 / 部分退款 / 修正是次动作，描边。
 *      发货不可用时（已发货、已退款…）整条操作条没有实心按钮——没有"该往前推"的动作就不该有主按钮。
 * @limitation 部分退款也会动钱，但它是售后常用动作，用灰色描边而不是红色，避免一屏两颗红按钮互相稀释。
 */
export function actionButtonClass(key: ActionKey): string {
  if (key === 'ship') return 'btn';
  if (key === 'refund' || key === 'release') return 'btn btn-danger-outline';
  return 'btn btn-secondary';
}

export interface OrderActionsProps {
  api: AdminApi;
  id: string;
  order: AdminOrderLike;
  sink: ToastSink;
  reload: () => Promise<AdminOrderLike | null>;
  onChanged: () => void;
}

export function OrderActions({ api, id, order, sink, reload, onChanged }: OrderActionsProps) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const [busy, setBusy] = useState(false);
  const available = availableActions(order);
  const current = open !== null && available.has(open) ? open : null;

  // 闸门关了（例如发货成功后变 shipped）→ 抽屉收起，且不在闸门重开时"自己弹回来"
  useEffect(() => {
    if (open !== null && current === null) setOpen(null);
  }, [open, current]);

  const close = (): void => {
    setOpen(null);
    setBusy(false);
  };
  const common = { api, id, order, sink, reload, onChanged, onDone: close, onBusy: setBusy };
  const refreshed = async (): Promise<AdminOrderLike | null> => {
    const fresh = await reload();
    onChanged();
    return fresh;
  };

  const body: Record<ActionKey, () => ReactNode> = {
    ship: () => <ShipForm {...common} />,
    refund: () => <RefundForm {...common} />,
    release: () => <ReleaseForm {...common} />,
    partial: () => (
      <PartialRefunds
        api={api}
        orderId={id}
        order={order}
        onDone={refreshed}
        onError={(m, traceId) => sink.error(m, { traceId })}
        onNotice={(m) => sink.info(m)}
        // ⚠️ 成功单独一条通道：走 info 的话上一次失败的错误条会留着，屏幕上红绿各一条
        onSuccess={(m) => sink.success(m)}
      />
    ),
    // key 随地址变化（A-02）：表单初值只在挂载时取，地址变了要重挂才会预填当前地址
    address: () => (
      <OrderAddressForm
        key={JSON.stringify((order as { address?: unknown }).address ?? null)}
        api={api}
        id={id}
        order={order}
        sink={sink}
        onDone={(message) => {
          void reload().then(() => sink.success(message));
          onChanged();
          close();
        }}
        // 联动走查（2026-10-10）：确认改址时别人刚发了货 → 刷新详情并收起抽屉，页头立刻变成"已发货"
        onStale={(traceId) => {
          void reload().then((fresh) => sink.error(staleNotice(fresh !== null), { traceId }));
          onChanged();
          close();
        }}
      />
    ),
    fix: () => (
      <OrderFixActions
        api={api}
        orderId={id}
        order={order}
        onDone={refreshed}
        onError={(m, traceId) => sink.error(m, { traceId })}
        onNotice={(m) => sink.info(m)}
      />
    ),
  };

  const ship = shipGate(order);
  const refund = refundGate(order);
  const spec = ACTIONS.find((a) => a.key === current);

  return (
    <div className="form">
      <span className="label">操作</span>
      <div className="action-bar">
        {ACTIONS.filter((a) => available.has(a.key)).map((a) => (
          <button
            key={a.key}
            type="button"
            className={actionButtonClass(a.key)}
            onClick={() => setOpen(a.key)}
          >
            {a.button}
          </button>
        ))}
      </div>
      {!ship.ok && <p className="muted">发货：{ship.reason}</p>}
      {!refund.ok && <p className="muted">全额退款：{refund.reason}</p>}
      {current !== null && spec !== undefined && (
        <ActionDrawer title={spec.title} busy={busy} onClose={close}>
          {body[current]()}
        </ActionDrawer>
      )}
    </div>
  );
}
