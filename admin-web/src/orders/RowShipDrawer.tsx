/**
 * 职责：订单列表「待发货」页签每行的「发货」抽屉（AJ-410 / N12）——不进详情就能发一单。
 *
 * @why 直接复用订单详情的 `ShipForm`（同一份闸门 shipGate、同一份校验 shipErrors、同一个"再输一次运单号"确认），
 *      不另写一份发货逻辑：两份迟早漂移，列表这条就会成为绕过闸门的后门（与 AJ-401 批量发货同一条理由）。
 * @limitation 列表行是 `AdminOrderListItem`（没有地址 / 事件），`ShipForm` 只用到状态、拒付、测试单三项闸门，够用；
 *             发货成功后刷新列表（这单离开待发货页签），不重取单条详情——`reload` 返回 null。
 */
import { useState } from 'react';
import { ActionDrawer } from '../ui/drawer.js';
import type { ToastSink } from '../ui/toast.js';
import type { AdminApi, AdminOrderLike } from './api.js';
import { ShipForm } from './ShipForm.js';

export function RowShipDrawer({
  api,
  order,
  sink,
  onClose,
  onShipped,
}: {
  api: AdminApi;
  order: AdminOrderLike;
  sink: ToastSink;
  onClose: () => void;
  /** 发货成功：刷新列表。 */
  onShipped: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ActionDrawer
      title={`发货：订单 ${order.order_no ?? order.order_id}`}
      busy={busy}
      onClose={onClose}
    >
      <ShipForm
        api={api}
        id={order.order_id}
        order={order}
        sink={sink}
        reload={async () => null}
        onChanged={onShipped}
        onDone={onClose}
        onBusy={setBusy}
      />
    </ActionDrawer>
  );
}
