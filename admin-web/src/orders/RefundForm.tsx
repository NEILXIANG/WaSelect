/**
 * 职责：订单详情「全额退款」抽屉里的表单——填原因，两步确认后原币全额退（AJ-398 从 OrderDetail 拆出）。
 *
 * @why 搬家不改逻辑：校验（`refundErrors`）、确认文案、三种 outcome 的分别提示（B41 / AJ-215）、
 *      出错后"先刷新详情再按真实状态说话"（AJ-230 / P2-49）都与拆分前逐字一致。
 * @why 成功（含 pending / 无确认结果）后关抽屉；**失败不关**：原因还在框里，看完提示可以直接再提交。
 *
 * @why AJ-400：原因改为"预设 + 补充说明"（./refund-reason.ts），拼好后再走原来的 `refundErrors` / `toRefundBody`，
 *      所以服务端看到的仍是一个 reason 字符串，长度口径不变。
 *
 * @limitation 出错 ≠ 没退：服务端先落 `refunding` 再调机构，超时时订单很可能已经变了，
 *              所以 catch 里先 `reload()`，提示按刷新后的订单给（`fullRefundErrorNotice`）。
 * @see ./view.ts（refundGate / refundErrors / fullRefundErrorNotice）
 */
import { useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { ApiError, retryAfterMsSec } from '../api/errors.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { refundOrder } from './api.js';
import { fullRefundAmountText, fullRefundConfirmBody } from './partial-refund-view.js';
import type { OrderActionFormProps } from './ShipForm.js';
import {
  firstRefundReason,
  fullRefundErrorNotice,
  refundErrors,
  refundGate,
  toRefundBody,
} from './view.js';
import { composeRefundReason, emptyRefundReason } from './refund-reason.js';
import { RefundReasonField } from './RefundReasonField.js';
import { enterClicksPrimary } from '../ui/keys.js';

/** 预设 + 说明 → 原有校验的输入形状；拼不出来时带上提示，由 check 统一报。 */
function checkReason(input: ReturnType<typeof emptyRefundReason>): {
  ok: boolean;
  first: string;
  reason: string;
} {
  const composed = composeRefundReason(input);
  if (!composed.ok) return { ok: false, first: composed.error, reason: '' };
  return { ...refundErrors({ reason: composed.reason }), reason: composed.reason };
}

export function RefundForm({
  api,
  id,
  order,
  sink,
  reload,
  onChanged,
  onDone,
  onBusy,
}: OrderActionFormProps) {
  const [refund, setRefund] = useState(emptyRefundReason);
  useFormDirty(refund, emptyRefundReason());
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean): void => {
    setBusyState(b);
    onBusy(b);
  };
  const gate = refundGate(order);
  // 退款中的单重试：沿用第一次的原因（服务端也只认它；两端逐页走查第三轮 2026-10-12）
  const retryReason =
    (order as { status?: unknown }).status === 'refunding' ? firstRefundReason(order) : null;
  /** 原因没填好时标在原因框下（规律排查 2026-10-12：原先只进右下角浮层）。 */
  const [reasonError, setReasonError] = useState('');
  const reasonCheck = (): ReturnType<typeof checkReason> =>
    retryReason !== null ? { ok: true, first: '', reason: retryReason } : checkReason(refund);

  const doRefund = async (): Promise<void> => {
    const check = reasonCheck();
    if (!check.ok) {
      setReasonError(check.first);
      setDialog(null);
      return;
    }
    setBusy(true);
    try {
      const outcome = await refundOrder(api, id, toRefundBody({ reason: check.reason }));
      setRefund(emptyRefundReason());
      setDialog(null);
      // ⚠️ 三种 outcome 必须分别说（B41 / AJ-215）：pending 当成"成功"会让运营去 Stripe 后台手工再退一次。
      //    后两档给 sticky：它们写的是"下一步怎么办"，3 秒后消失等于没说。
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
      await reload();
      onChanged();
      setBusy(false);
      onDone();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      const code = e instanceof ApiError ? e.code : 0;
      const traceId = e instanceof ApiError ? e.traceId : undefined;
      setDialog(null);
      const fresh = await reload();
      onChanged();
      sink.error(message, { traceId });
      // 按刷新后的真实状态说话（P2-49）：已退成 / 机构确认失败 / 结果未知 / 50300 未发出
      const reason = e instanceof ApiError ? e.data?.['reason'] : undefined;
      sink.info(
        fullRefundErrorNotice({ code, retryAfterSec: retryAfterMsSec(e), reason, order: fresh }),
        {
          sticky: true,
        },
      );
      setBusy(false);
    }
  };

  const ask = (): void => {
    const check = reasonCheck();
    if (!check.ok) {
      setReasonError(check.first);
      return;
    }
    setDialog({
      title: '全额退款：原币退，不可撤销',
      // 严格检查 A-2：写实际要退的钱（原币实收 − 已成功部分退款），不是订单合计
      body: fullRefundConfirmBody({ ...order, order_no: order.order_no ?? id }),
      confirmText: '确认退款',
      danger: true,
    });
  };

  return (
    <div className="form" onKeyDown={enterClicksPrimary}>
      {/* 硬上限来自 shared（B7 / AJ-191）：超长会被机构拒且订单卡在退款中——按拼好后的整串校验 */}
      {/* 全入口点击测试 2026-10-11：先写要退多少（原先金额要回页面找，确认框里才有；与确认框同一个函数） */}
      <p className="refund-amount">退款金额：{fullRefundAmountText(order)}</p>
      {retryReason !== null ? (
        <p className="muted">沿用第一次的退款原因：{retryReason}</p>
      ) : (
        <RefundReasonField
          value={refund}
          onChange={(next) => {
            setRefund(next);
            setReasonError('');
          }}
          error={reasonError}
        />
      )}
      <button
        type="button"
        className="btn btn-danger"
        data-primary-action
        disabled={!gate.ok || busy}
        onClick={ask}
      >
        {retryReason !== null ? '重新提交退款' : '退款'}
      </button>
      {/* 放行时也可能带提示（refunding = 再查询/重发，KD-12） */}
      {gate.reason !== '' && <p className="muted">{gate.reason}</p>}
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void doRefund()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
