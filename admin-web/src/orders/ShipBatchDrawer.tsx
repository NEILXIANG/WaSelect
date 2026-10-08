/**
 * 职责：列表「待发货」勾选后的**批量发货抽屉**（AJ-401）——每单一行：承运商 + 运单号，逐行即时校验。
 *
 * @why 承运商顶部一个"统一承运商"框改全部行：一批单通常同一家承运商；个别行可再单独改。
 *      默认值取上一次批量用过的（last-carrier.ts），没有就空着让人填——不猜。
 * @why 形状警告（认不出的运单号）与单单发货同一句提示、同一个判定（shared trackingNoRecognized），只提示不拦。
 * @why 行内错误（承运商 / 运单号必填）**编辑过该行或点过一次提交**才显示（验收 2026-10-08）：
 *      刚打开就满屏红字，像是运营做错了什么；与单单发货"点了才红"同口径。订单级问题（blockers）始终显示。
 * @limitation 「统一承运商」不算编辑某一行——否则填完承运商，所有还没填运单号的行一起变红，等于没改。
 * @limitation 勾选只在**当前页**内（列表一页 20 单）；跨页勾选要翻页后再开一次。
 * @see ./ship-batch.ts（校验 / 提交体）；./BatchSubmit.tsx（确认与结果）
 */
import { useState } from 'react';
import { SHIP_MAX_CHARS } from '@waselect/shared';
import { ActionDrawer } from '../ui/drawer.js';
import { FormDirty } from '../ui/unsaved.js';
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
  /** 点过一次提交：所有行的问题都亮出来。 */
  const [attempted, setAttempted] = useState(false);
  /** 编辑过的行（按下标；行集合在抽屉生命周期内不变）。 */
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());

  const edit = (i: number, patch: Partial<BatchRow>): void => {
    setTouched((prev) => new Set(prev).add(i));
    setRows((list) => validateRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r))));
  };
  const shown = (i: number, r: BatchRow): Pick<BatchRow, 'errors' | 'warnings'> =>
    attempted || touched.has(i) ? r : { errors: r.blockers, warnings: r.warnings };
  const setAllCarriers = (v: string): void => {
    setCarrier(v);
    setRows((list) => validateRows(list.map((r) => ({ ...r, carrier: v }))));
  };

  return (
    // 单数取打开时的快照：发货后列表重载会清空勾选，`orders` 随之变空，标题不能跟着变成"已选 0 单"
    <ActionDrawer wide title={`批量发货（已选 ${String(initial.length)} 单）`} onClose={onClose}>
      <>
        {/* 脏态必须在抽屉里面上报（FormDirty @why） */}
        <FormDirty
          current={done ? [] : rows.map((r) => r.trackingNo)}
          pristine={done ? [] : initial.map((r) => r.trackingNo)}
        />
        <label className="muted">
          统一承运商{' '}
          <input
            className="input"
            aria-label="统一承运商"
            maxLength={SHIP_MAX_CHARS.carrier}
            value={carrier}
            placeholder="例：Japan Post"
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
                  <BatchRowIssues row={shown(i, r)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <BatchSubmit
          api={api}
          rows={rows}
          revealed={rows.every((r, i) => shown(i, r).errors.length === r.errors.length)}
          onReveal={() => setAttempted(true)}
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
