/**
 * 职责：订单详情里的**部分退款**面板（AJ-383）——已有记录 + 发起一笔（两步确认）+ 同步在途的一笔。
 *
 * @why 独立成组件而不是塞进 OrderDetail：详情页已过 400 行，部分退款有自己的表单状态与确认步骤；
 *      逻辑全在 `partial-refund-view.ts`（纯函数、有单测），这里只做渲染与调用。
 * @why 金额框填的是**主单位**（10.50），提交前换成最小单位（1050）；换算失败就不发请求、原地提示。
 * @limitation 失败 / 结果未知统一交给父组件的错误条显示，并刷新详情——行状态以服务端为准，不在前端编造。
 * @why 出错时**先刷新、再报错**（P2-49）：父组件的 `load` 开头会清错误条，旧顺序（先 onError 再 onDone）
 *      让错误一闪就没了；刷新后再按那一行的真实状态给提示（`partialRefundErrorNotice`）。
 *
 * @see ./partial-refund-view.ts；server/src/app/partial-refund-routes.ts
 */
import { useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { useDrawerBusy } from '../ui/drawer.js';
import { composeRefundReason, emptyRefundReason } from './refund-reason.js';
import { RefundReasonField } from './RefundReasonField.js';
import { ApiError, retryAfterMsSec } from '../api/errors.js';
import { createPartialRefund, syncPartialRefund, type AdminApi } from './api.js';
import {
  partialRefundErrorNotice,
  partialRefundGate,
  partialRefundInputCheck,
  partialRefundRows,
  refundableMinor,
  currencyName,
} from './partial-refund-view.js';
import { enterClicksPrimary, blockEnter } from '../ui/keys.js';
import { mouseOnlyHint } from '../ui/confirm.js';

/**
 * 金额框的标签与示例按币种给（三端联动模拟 2026-10-08：日元单写着"如 10.50"，日元没有小数）。
 * @why AJ-410 / N28：标签写中文币种名与"整数 / 两位小数"，不写 `JPY`——新手不认识币种代码。
 */
export function amountLabel(currency: string): { label: string; example: string } {
  if (currency === '') return { label: '金额', example: '' };
  if (currency === 'JPY') return { label: '金额（日元，整数）', example: '例：500' };
  return { label: `金额（${currencyName(currency)}，最多两位小数）`, example: '例：10.50' };
}

export interface PartialRefundsProps {
  api: AdminApi;
  orderId: string;
  order: unknown;
  /** 一次写操作结束（成功或失败都调）：父组件据此刷新详情与列表，返回刷新后的订单（取不到为 null）。 */
  onDone: () => unknown;
  onError: (message: string) => void;
  /** 信息性提示（失败后的"下一步怎么办"）；不传则并入错误条。 */
  onNotice?: ((message: string) => void) | undefined;
  /**
   * **成功**提示的独立出口。
   *
   * @why 必须和 `onNotice`（info 通道）分开：Toast 的清屏规则是"success 清空全部，
   *      而 info 与 error **刻意并存**"（退款失败时 error 与 info 是同一件事的两半，
   *      挤掉任何一半都只剩半句）。
   *      成功话如果走 info 通道，上一次失败的红字会一直挂在屏幕上，
   *      运营看见"红+绿"两条分不清这次到底成没成（三端联动模拟 2026-10-08 实测）。
   * @limitation 不传时回落到 `onNotice`（保持旧行为，但也就拿不到清屏）。
   */
  onSuccess?: ((message: string) => void) | undefined;
}

export function PartialRefunds({
  api,
  orderId,
  order,
  onDone,
  onError,
  onNotice,
  onSuccess,
}: PartialRefundsProps) {
  const [amount, setAmount] = useState('');
  // AJ-400：原因 = 预设 + 补充说明（./refund-reason.ts），拼好后再进原有的额度 / 必填校验
  const [reason, setReason] = useState(emptyRefundReason);
  useFormDirty(
    { amount: amount.trim(), preset: reason.preset, note: reason.note.trim() },
    { amount: '', preset: '', note: '' },
  );
  const [confirming, setConfirming] = useState(false);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  useDrawerBusy(busy); // 提交中锁住所在抽屉的关闭出口

  const gate = partialRefundGate(order);
  const currency = refundableMinor(order)?.currency ?? '';
  const rows = partialRefundRows(order);

  const run = async (fn: () => Promise<unknown>, refundId?: string): Promise<void> => {
    setBusy(true);
    onNotice?.(''); // 上一个动作的提示不留到这次
    const knownIds = rows.map((r) => r.id);
    let failure: unknown = undefined;
    try {
      await fn();
    } catch (e) {
      failure = e ?? new Error('unknown');
    }
    setBusy(false);
    const fresh = await onDone();
    if (failure === undefined) {
      // ⚠️ 成功必须走 success 通道（清屏），不能走 info——
      //    否则上一次失败的红字留着，屏幕上同时有红有绿（见 onSuccess 的 @why）
      const say = onSuccess ?? onNotice;
      say?.('部分退款已提交：结果以上方记录的状态为准（处理中的可点「同步」）');
      return;
    }
    onError(failure instanceof ApiError ? failure.message : String(failure));
    const notice = partialRefundErrorNotice({
      code: failure instanceof ApiError ? failure.code : 0,
      retryAfterSec: retryAfterMsSec(failure),
      order: fresh,
      refundId,
      knownIds,
    });
    if (notice !== '') (onNotice ?? onError)(notice);
  };

  /** 先拼原因（预设必选 / 「其它」必填），再走原有校验（金额格式 → 额度）。 */
  const inputCheck = ():
    { ok: true; minor: number; reason: string } | { ok: false; reason: string } => {
    const composed = composeRefundReason(reason);
    if (!composed.ok) return { ok: false, reason: composed.error };
    const check = partialRefundInputCheck({ amount, reason: composed.reason, order });
    return check.ok ? { ok: true, minor: check.minor, reason: composed.reason } : check;
  };

  const ask = (): void => {
    const check = inputCheck();
    if (!check.ok) return setHint(check.reason);
    setHint('');
    setConfirming(true);
  };

  const submit = async (): Promise<void> => {
    // 二次确认那一步也要重算：确认期间额度可能已被别的操作占掉（这里的额度来自这份 order 快照）
    const check = inputCheck();
    if (!check.ok) {
      setConfirming(false);
      setHint(check.reason);
      return;
    }
    setConfirming(false);
    await run(async () => {
      await createPartialRefund(api, orderId, {
        amount_minor: check.minor,
        reason: check.reason,
      });
      setAmount('');
      setReason(emptyRefundReason());
    });
  };

  return (
    <div className="form" onKeyDown={enterClicksPrimary}>
      <span className="label">部分退款 / 售后退款（订单状态不变，库存不会加回去）</span>
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
                      onClick={() => void run(() => syncPartialRefund(api, orderId, r.id), r.id)}
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
      {/* N29：一打开就说还能退多少（放在输入框上面，填之前就看得到） */}
      {gate.reason !== '' && <p className="muted">{gate.reason}</p>}
      <label className="field">
        <span className="label">{amountLabel(currency).label}</span>
        <input
          className="input"
          name="partial-amount"
          placeholder={amountLabel(currency).example}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setHint(''); // N30：改了就清掉旧提示，不让过期的红字挂着
            setConfirming(false);
          }}
        />
      </label>
      <RefundReasonField
        value={reason}
        onChange={(next) => {
          setReason(next);
          setHint(''); // N30：选了原因后「请选择退款原因」不该还挂着
          setConfirming(false);
        }}
        noteName="partial-reason"
      />
      {confirming ? (
        <div className="row2">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onKeyDown={blockEnter}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : '确认部分退款'}
          </button>
          <button type="button" className="link" onClick={() => setConfirming(false)}>
            取消
          </button>
          <span className="muted">{mouseOnlyHint('确认部分退款')}</span>
        </div>
      ) : (
        <button
          type="button"
          className="btn"
          data-primary-action
          disabled={!gate.ok || busy}
          onClick={ask}
        >
          部分退款
        </button>
      )}
      {hint !== '' && <p className="error">{hint}</p>}
    </div>
  );
}
