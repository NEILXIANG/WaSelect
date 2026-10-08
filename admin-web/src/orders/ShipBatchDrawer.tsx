/**
 * 职责：列表「待发货」勾选后的**批量发货抽屉**（AJ-401）——每单一行：承运商 + 运单号，逐行即时校验。
 *
 * @why 承运商顶部一个"统一承运商"框改全部行：一批单通常同一家承运商；个别行可再单独改。
 *      默认值取上一次批量用过的（last-carrier.ts），没有就空着让人填——不猜。
 * @why 形状警告（认不出的运单号）与单单发货同一句提示、同一个判定（shared trackingNoRecognized），只提示不拦。
 * @limitation 勾选只在**当前页**内（列表一页 20 单）；跨页勾选要翻页后再开一次。
 * @see ./ship-batch.ts（校验 / 提交体）；./BatchSubmit.tsx（确认与结果）
 */
import { useState } from 'react';
import { SHIP_MAX_CHARS } from '@waselect/shared';
import { ActionDrawer } from '../ui/drawer.js';
import { useFormDirty } from '../ui/unsaved.js';
import type { AdminApi, AdminOrderLike } from './api.js';
import { BatchSubmit } from './BatchSubmit.js';
import { BatchRowIssues } from './BatchRowIssues.js';
import { readLastCarrier, saveLastCarrier } from './last-carrier.js';
import { selectionRows, validateRows, type BatchRow } from './ship-batch.js';

export interface ShipBatchDrawerProps {
  api: AdminApi;
  orders: readonly AdminOrderLike[];
  onClose: () => void;
  /** 拿到逐单结果后（刷新列表）。 */
  onDone: () => void;
  onError: (text: string, traceId: string | undefined) => void;
}

export function ShipBatchDrawer({ api, orders, onClose, onDone, onError }: ShipBatchDrawerProps) {
  const [initial] = useState(() => validateRows(selectionRows(orders, readLastCarrier())));
  const [rows, setRows] = useState<BatchRow[]>(initial);
  const [carrier, setCarrier] = useState(initial[0]?.carrier ?? '');
  /** 已提交（拿到结果）：输入不再算"未保存"，关抽屉不必再问。 */
  const [done, setDone] = useState(false);
  useFormDirty(
    done ? [] : rows.map((r) => r.trackingNo),
    done ? [] : initial.map((r) => r.trackingNo),
  );

  const edit = (i: number, patch: Partial<BatchRow>): void =>
    setRows((list) => validateRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r))));
  const setAllCarriers = (v: string): void => {
    setCarrier(v);
    setRows((list) => validateRows(list.map((r) => ({ ...r, carrier: v }))));
  };

  return (
    // 单数取打开时的快照：发货后列表重载会清空勾选，`orders` 随之变空，标题不能跟着变成"已选 0 单"
    <ActionDrawer wide title={`批量发货（已选 ${String(initial.length)} 单）`} onClose={onClose}>
      <>
        <label className="muted">
          统一承运商{' '}
          <input
            className="input"
            aria-label="统一承运商"
            maxLength={SHIP_MAX_CHARS.carrier}
            value={carrier}
            placeholder="如 Japan Post"
            onChange={(e) => setAllCarriers(e.target.value)}
          />
        </label>
        <table className="table">
          <thead>
            <tr>
              <th>订单号</th>
              <th>承运商</th>
              <th>运单号</th>
              <th>提示</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.orderId ?? r.orderNo}>
                <td>{r.orderNo}</td>
                <td>
                  <input
                    className="input"
                    aria-label={`${r.orderNo} 承运商`}
                    maxLength={SHIP_MAX_CHARS.carrier}
                    value={r.carrier}
                    onChange={(e) => edit(i, { carrier: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    aria-label={`${r.orderNo} 运单号`}
                    maxLength={SHIP_MAX_CHARS.tracking_no}
                    value={r.trackingNo}
                    onChange={(e) => edit(i, { trackingNo: e.target.value })}
                  />
                </td>
                <td>
                  <BatchRowIssues row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <BatchSubmit
          api={api}
          rows={rows}
          onError={onError}
          onDone={() => {
            setDone(true);
            saveLastCarrier(carrier);
            onDone();
          }}
        />
      </>
    </ActionDrawer>
  );
}
