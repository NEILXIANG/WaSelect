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
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { toastError } from '../ui/toast.js';
import { releaseDisputeHold } from './api.js';
import type { OrderActionFormProps } from './ShipForm.js';
import { emptyReleaseForm, RELEASE_DONE_NOTICE, releaseErrors, toReleaseBody } from './view.js';

export function ReleaseForm({
  api,
  id,
  sink,
  reload,
  onChanged,
  onDone,
  onBusy,
}: OrderActionFormProps) {
  const [release, setRelease] = useState(emptyReleaseForm);
  useFormDirty(release, emptyReleaseForm());
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean): void => {
    setBusyState(b);
    onBusy(b);
  };

  const doRelease = async (): Promise<void> => {
    const check = releaseErrors(release);
    if (!check.ok) {
      sink.error(check.first);
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
      sink.error(check.first);
      return;
    }
    setDialog({
      title: '解除后发货闸门立即打开，且不可撤销',
      body: '拒付本身不会结案：`payments.dispute_*` 一个字都不会改，这条拒付仍留在风控列表，机构仍可能判败诉并把钱收回。确认后这张单可以被发货、被退款。',
      confirmText: '确认解除（不可撤销）',
      danger: true,
    });
  };

  return (
    <div className="form">
      <p className="error">
        ⚠️ 该订单有进行中的拒付：退款会被拒（40907），发货也会拦住（发货后钱货两空）。
        若拒付链已断——机构漏发结案事件、或已与买家协商和好、或败诉单另作处置——
        可在这里人工解除限制。
      </p>
      <input
        className="input"
        placeholder="解除理由（进审计台账与订单时间线）"
        // 硬上限来自 shared（与服务端同一个常量，AJ-291）
        maxLength={ADMIN_NOTE_MAX_LENGTH}
        value={release.reason}
        onChange={(e) => setRelease({ reason: e.target.value })}
      />
      <button type="button" className="btn btn-danger" disabled={busy} onClick={ask}>
        人工解除拒付限制
      </button>
      <p className="muted">
        解除的是「限制」不是「事实」：`payments.dispute_*` 一个字都不会改，
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
