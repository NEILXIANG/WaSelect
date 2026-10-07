/**
 * 职责：订单详情里的**部分退款**面板（AJ-383）——已有记录 + 发起一笔（两步确认）+ 同步在途的一笔。
 *
 * @why 独立成组件而不是塞进 OrderDetail：详情页已过 400 行，部分退款有自己的表单状态与确认步骤；
 *      逻辑全在 `partial-refund-view.ts`（纯函数、有单测），这里只做渲染与调用。
 * @why 金额框填的是**主单位**（10.50），提交前换成最小单位（1050）；换算失败就不发请求、原地提示。
 * @limitation 失败 / 结果未知统一交给父组件的错误条显示，并刷新详情——行状态以服务端为准，不在前端编造。
 *
 * @see ./partial-refund-view.ts；server/src/app/partial-refund-routes.ts
 */
import { useState } from 'react';
import { REFUND_REASON_MAX_LENGTH } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { createPartialRefund, syncPartialRefund, type AdminApi } from './api.js';
import {
  parseAmountToMinor,
  partialRefundGate,
  partialRefundRows,
  refundableMinor,
} from './partial-refund-view.js';

export interface PartialRefundsProps {
  api: AdminApi;
  orderId: string;
  order: unknown;
  /** 一次写操作结束（成功或失败都调）：父组件据此刷新详情与列表。 */
  onDone: () => void | Promise<void>;
  onError: (message: string) => void;
}

export function PartialRefunds({ api, orderId, order, onDone, onError }: PartialRefundsProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  const gate = partialRefundGate(order);
  const currency = refundableMinor(order)?.currency ?? '';
  const rows = partialRefundRows(order);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };

  const ask = (): void => {
    const parsed = parseAmountToMinor(amount, currency);
    if (!parsed.ok) return setHint(parsed.reason);
    if (reason.trim() === '') return setHint('请填写退款原因（进审计台账）');
    setHint('');
    setConfirming(true);
  };

  const submit = async (): Promise<void> => {
    const parsed = parseAmountToMinor(amount, currency);
    if (!parsed.ok) return setHint(parsed.reason);
    setConfirming(false);
    await run(async () => {
      await createPartialRefund(api, orderId, {
        amount_minor: parsed.minor,
        reason: reason.trim(),
      });
      setAmount('');
      setReason('');
    });
  };

  return (
    <div className="form">
      <span className="label">部分退款 / 售后退款（订单状态不变，不回补库存）</span>
      {rows.length > 0 && (
        <table className="table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.amount}</td>
                <td>{r.statusText}</td>
                <td>{r.reason}</td>
                <td>
                  {r.canSync && (
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => void run(() => syncPartialRefund(api, orderId, r.id))}
                    >
                      同步
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <input
        className="input"
        name="partial-amount"
        placeholder={currency === '' ? '金额' : `金额（${currency}，如 10.50）`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        className="input"
        name="partial-reason"
        placeholder="退款原因（进审计台账）"
        maxLength={REFUND_REASON_MAX_LENGTH}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {confirming ? (
        <div className="row2">
          <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '确认部分退款'}
          </button>
          <button type="button" className="link" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      ) : (
        <button type="button" className="btn" disabled={!gate.ok || busy} onClick={ask}>
          部分退款
        </button>
      )}
      {hint !== '' && <p className="error">{hint}</p>}
      {gate.reason !== '' && <p className="muted">{gate.reason}</p>}
    </div>
  );
}
