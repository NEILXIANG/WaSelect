/**
 * 职责：订单详情「解除拒付限制」抽屉里的表单（B1b / AJ-194 逃生口；AJ-398 从 OrderDetail 拆出）。
 *
 * @why 这是**逃生口**不是常规操作：`has_dispute` 只能靠机构的 `charge.dispute.closed` 变回 false，
 *      那条链断了（漏发 / 没接住 / 已与买家和好）订单就永久锁死；人工解除留痕、可复核。
 * @why 搬家不改逻辑：校验（`releaseErrors`）、确认文案、成功后的 sticky 警告（RELEASE_DONE_NOTICE）与拆分前一致。
 *
 * @limitation 解除的是「限制」不是「事实」：`payments.dispute_*` 不改，拒付仍在风控列表，机构仍可能判败诉。
 * @see ./view.ts（isDisputeLocked / releaseErrors / RELEASE_DONE_NOTICE）
 */
import { useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { useFormDirty } from '../ui/unsaved.js';
import { enterClicksPrimary } from '../ui/keys.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { toastError } from '../ui/toast.js';
import { releaseDisputeHold } from './api.js';
import type { OrderActionFormProps } from './ShipForm.js';
import {
  disputeLockState,
  emptyReleaseForm,
  RELEASE_DONE_NOTICE,
  releaseErrors,
  toReleaseBody,
} from './view.js';

export function ReleaseForm({
  api,
  id,
  order,
  sink,
  reload,
  onChanged,
  onDone,
  onBusy,
}: OrderActionFormProps) {
  const [release, setRelease] = useState(emptyReleaseForm);
  useFormDirty(release, emptyReleaseForm());
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  /** 理由没填好时标在框下（规律排查 2026-10-12：原先只进右下角浮层）。 */
  const [reasonError, setReasonError] = useState('');
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean): void => {
    setBusyState(b);
    onBusy(b);
  };

  const doRelease = async (): Promise<void> => {
    const check = releaseErrors(release);
    if (!check.ok) {
      setReasonError(check.first);
      setDialog(null);
      return;
    }
    setBusy(true);
    try {
      await releaseDisputeHold(api, id, toReleaseBody(release));
      setRelease(emptyReleaseForm());
      setDialog(null);
      // ⚠️ 这句是**警告**不是确认：拒付没结案，而发货闸门恰恰在这一刻打开了——所以 sticky
      sink.info(RELEASE_DONE_NOTICE, { sticky: true });
      await reload();
      onChanged();
      setBusy(false);
      onDone();
    } catch (e) {
      setDialog(null);
      setBusy(false);
      const { text, traceId } = toastError(e, '解除拒付限制失败');
      sink.error(text, { traceId });
    }
  };

  const ask = (): void => {
    const check = releaseErrors(release);
    if (!check.ok) {
      setReasonError(check.first);
      return;
    }
    setDialog({
      title: '解除后发货闸门立即打开，且不可撤销',
      body: '拒付本身不会因此结束：这条拒付仍留在风控列表，支付平台仍可能判店铺输、把钱收回。确认后这张单可以被发货、被退款。',
      confirmText: '确认解除（不可撤销）',
      danger: true,
    });
  };

  return (
    <div className="form" onKeyDown={enterClicksPrimary}>
      <p className="error">
        ⚠️
        {/* 分清进行中 / 已败诉（规律排查 2026-10-12：has_dispute 两者都是 true，原先一律写"正在要回货款"）。
            败诉多一句：解除后系统仍按败诉金额拦（AJ-516）——整单退款不可用，部分退款额度已扣掉银行退回的那部分 */}
        {disputeLockState(order) === 'lost'
          ? '这张订单的拒付已败诉（货款已被银行退回买家）：退款和发货都被系统锁住了。解除后，已被银行退回买家的那部分仍不能再退：整单退款不可用，其余部分可用「部分退款」。'
          : disputeLockState(order) === 'open'
            ? '这张订单的买家正在通过银行要回货款（拒付）：现在退款和发货都被系统锁住了（防止钱和货都没了）。'
            : '这张订单有未解除的拒付限制：现在退款和发货都被系统锁住了。'}
        若拒付链已断——机构漏发结案事件、或已与买家协商和好、或败诉单另作处置——
        可在这里人工解除限制。
      </p>
      <label className="field">
        <span className="label">解除理由（会记录在订单时间线里）</span>
        <input
          className="input"
          name="release-reason"
          autoFocus
          placeholder="例：已与买家协商和好，买家已撤回拒付"
          // 硬上限来自 shared（与服务端同一个常量，AJ-291）
          maxLength={ADMIN_NOTE_MAX_LENGTH}
          value={release.reason}
          onChange={(e) => {
            setRelease({ reason: e.target.value });
            setReasonError('');
          }}
        />
        {reasonError !== '' && (
          <span className="error" role="alert">
            {reasonError}
          </span>
        )}
      </label>
      <button
        type="button"
        className="btn btn-danger"
        data-primary-action
        disabled={busy}
        onClick={ask}
      >
        人工解除拒付限制
      </button>
      <p className="muted">
        解除的只是系统的「锁」，不是拒付本身：拒付记录不会被改动，
        这条拒付仍留在风控列表，机构仍可能判败诉并把钱收回。
      </p>
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void doRelease()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
