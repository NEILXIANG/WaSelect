/**
 * 职责：订单详情里的两个"修正"动作（AJ-386）——取消未付订单（P1-11）、改已发货订单的运单号（P1-10）。
 *
 * @why 独立成组件：OrderDetail 已近 500 行；两个动作各有"填原因 → 二次确认"的表单状态。
 *      门槛与校验在 `fix-view.ts`（纯函数、有单测），这里只做渲染与调用。
 * @why 两步确认：取消不可逆（库存回补、买家看到"已取消"）；改运单号会给买家**重发**一封发货邮件。
 * @limitation 失败统一交给父组件的错误条；成功后父组件刷新详情——状态以服务端为准。
 * @see ./fix-view.ts；server/src/app/admin-order-fix-routes.ts
 */
import { useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { ADMIN_NOTE_MAX_LENGTH, SHIP_MAX_CHARS } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { cancelOrder, fixShipment, type AdminApi } from './api.js';
import { trackingNoRecognized } from '@waselect/shared';
import {
  cancelGate,
  shipmentFixErrors,
  shipmentFixGate,
  TRACKING_SHAPE_WARNING,
  trackingWarning,
} from './fix-view.js';

export interface OrderFixActionsProps {
  api: AdminApi;
  orderId: string;
  order: unknown;
  onDone: () => unknown;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export function OrderFixActions({
  api,
  orderId,
  order,
  onDone,
  onError,
  onNotice,
}: OrderFixActionsProps) {
  const cancel = cancelGate(order);
  const fix = shipmentFixGate(order);
  const [mode, setMode] = useState<'' | 'cancel' | 'fix'>('');
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [carrier, setCarrier] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /**
   * 脏态：只在展开了「取消 / 改运单」之后才可能脏；改运单的基线是展开时预填的当前运单。
   * @limitation 只比文字输入，不把"展开了但没填"算脏——展开本身不产生要丢的东西。
   */
  useFormDirty(
    mode === ''
      ? null
      : {
          reason,
          carrier: mode === 'fix' ? carrier : '',
          trackingNo: mode === 'fix' ? trackingNo : '',
        },
    mode === ''
      ? null
      : {
          reason: '',
          carrier: mode === 'fix' && fix.ok ? fix.carrier : '',
          trackingNo: mode === 'fix' && fix.ok ? fix.trackingNo : '',
        },
  );

  if (!cancel.ok && !fix.ok) return null;

  // 输入即清掉该栏旧错误（三端联动模拟 2026-10-08：填好原因后红字「必填」还挂着）
  const clearError = (k: string): void => {
    setConfirming(false);
    setErrors((e) => {
      const rest = { ...e };
      delete rest[k];
      return rest;
    });
  };

  const reset = (): void => {
    setMode('');
    setConfirming(false);
    setReason('');
    setErrors({});
  };

  const open = (m: 'cancel' | 'fix'): void => {
    reset();
    setMode(m);
    if (m === 'fix' && fix.ok) {
      setCarrier(fix.carrier);
      setTrackingNo(fix.trackingNo);
    }
  };

  const ask = (): void => {
    const e =
      mode === 'fix'
        ? shipmentFixErrors({ carrier, trackingNo, reason })
        : reason.trim() === ''
          ? { reason: '取消原因必填（进审计）' }
          : reason.trim().length > ADMIN_NOTE_MAX_LENGTH
            ? { reason: `取消原因最多 ${ADMIN_NOTE_MAX_LENGTH} 字` }
            : {};
    setErrors(e);
    if (Object.keys(e).length === 0) setConfirming(true);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    onNotice(''); // 上一个动作的提示不留到这次（三端联动模拟：改单号的提示挂到了部分退款之后）
    let message = '';
    let warn = '';
    try {
      if (mode === 'cancel') {
        await cancelOrder(api, orderId, { reason: reason.trim() });
      } else {
        const resp = await fixShipment(api, orderId, {
          carrier: carrier.trim(),
          tracking_no: trackingNo.trim(),
          reason: reason.trim(),
        });
        warn = trackingWarning(resp);
      }
      reset();
    } catch (e) {
      setConfirming(false);
      message = e instanceof ApiError ? e.message : String(e);
    } finally {
      setBusy(false);
    }
    // 先刷新再提示：父组件的 load 开头会清错误条 / 提示（与 PartialRefunds 同一个 P2-49 顺序）
    await onDone();
    if (message !== '') onError(message);
    else
      onNotice(
        warn !== ''
          ? warn
          : mode === 'cancel'
            ? '订单已取消，库存已回补'
            : '运单号已更新，已给买家重发发货邮件',
      );
  };

  return (
    <div className="form">
      <span className="label">订单修正</span>
      {mode === '' && (
        <div className="row2">
          {cancel.ok && (
            <button className="btn" type="button" onClick={() => open('cancel')}>
              取消订单（未付款）
            </button>
          )}
          {fix.ok && (
            <button className="btn" type="button" onClick={() => open('fix')}>
              修改运单号
            </button>
          )}
        </div>
      )}
      {mode === 'fix' && (
        <>
          <label className="field">
            <span className="label">承运商</span>
            <input
              className="input"
              maxLength={SHIP_MAX_CHARS.carrier}
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value);
                clearError('carrier');
              }}
            />
            {errors['carrier'] !== undefined && <span className="error">{errors['carrier']}</span>}
          </label>
          <label className="field">
            <span className="label">运单号</span>
            <input
              className="input"
              maxLength={SHIP_MAX_CHARS.tracking_no}
              value={trackingNo}
              onChange={(e) => {
                setTrackingNo(e.target.value);
                clearError('trackingNo');
              }}
            />
            {errors['trackingNo'] !== undefined && (
              <span className="error">{errors['trackingNo']}</span>
            )}
          </label>
        </>
      )}
      {mode !== '' && (
        <>
          <label className="field">
            <span className="label">{mode === 'cancel' ? '取消原因' : '修改原因'}</span>
            <input
              className="input"
              maxLength={ADMIN_NOTE_MAX_LENGTH}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                clearError('reason');
              }}
            />
            {errors['reason'] !== undefined && <span className="error">{errors['reason']}</span>}
          </label>
          {confirming ? (
            <div className="row2">
              <span className="muted">
                {mode === 'cancel'
                  ? '确认取消？不可撤销，库存会回补。'
                  : '确认修改？会给买家重发一封发货邮件。'}
              </span>
              {mode === 'fix' && !trackingNoRecognized(carrier, trackingNo) && (
                <span className="error">{TRACKING_SHAPE_WARNING}</span>
              )}
              <button className="btn" type="button" disabled={busy} onClick={() => void submit()}>
                {busy ? '提交中…' : '确认'}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                再看看
              </button>
            </div>
          ) : (
            <div className="row2">
              <button className="btn" type="button" onClick={ask}>
                {mode === 'cancel' ? '取消这张订单' : '保存运单号'}
              </button>
              <button className="link" type="button" onClick={reset}>
                收起
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
