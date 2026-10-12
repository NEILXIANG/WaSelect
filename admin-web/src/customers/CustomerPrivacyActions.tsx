/**
 * 职责：客户详情页的**删除行为记录**（AJ-413）——APPI「用户要求删除」在后台的唯一入口。
 *
 * @why 与拉黑 / 解除（CustomerRiskActions）分开成一个组件：两者的后果、审计口径、出现条件都不同，
 *      混在一个 `form` 里会让"解除原因"与"删除原因"两个输入框互相串位。
 * @why 原因必填且先在前端挡"空着"：服务端也会拒（40001），但运营看到的应是一句中文提示，不是错误码。
 * @why 确认弹层用 danger：删除不可恢复，且确认框里按回车不放行（ui/confirm.tsx），必须鼠标点。
 * @limitation 只删行为记录（服务端口径）；订单 / 地址的匿名化出口尚未提供（AJ-292），文案里如实写"不受影响"。
 * @see ./CustomerRiskActions.tsx（同一套确认弹层与 Toast）；../../../server/src/app/admin-customer-routes.ts
 */
import { useRef, useState } from 'react';
import { ReasonInput } from '../ui/ReasonInput.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { toastError, type ToastSink } from '../ui/toast.js';
import { purgeCustomerEvents, type AdminApi } from './api.js';
import { CUSTOMER_PURGE_CONFIRM_TEXT } from './view.js';

export interface CustomerPrivacyActionsProps {
  api: AdminApi;
  userId: string;
  /** 客户称呼：确认弹层里写它，不写 36 位 id（全入口点击测试 2026-10-12）。 */
  customerName: string;
  sink: ToastSink;
}

export function CustomerPrivacyActions({
  api,
  userId,
  customerName,
  sink,
}: CustomerPrivacyActionsProps) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);

  const ask = (): void => {
    if (reason.trim() === '') {
      // 提示标在框下、光标放进去（原先走右下角浮层）
      setReasonError('请填写删除原因（会记录下来），例：买家邮件要求删除');
      reasonRef.current?.focus();
      return;
    }
    setDialog({
      title: '删除后无法恢复：该客户的使用记录会被永久清除',
      body: `${CUSTOMER_PURGE_CONFIRM_TEXT}\n\n客户：${customerName !== '' ? customerName : '该客户'}`,
      confirmText: '确认删除行为记录',
      danger: true,
    });
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const { deleted } = await purgeCustomerEvents(api, userId, reason.trim());
      setDialog(null);
      setReason('');
      sink.success(`已删除 ${String(deleted)} 条行为记录（已记录操作与原因）`);
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, '删除行为记录失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <span className="label">隐私请求：买家要求删除其使用记录时</span>
      <ReasonInput
        ref={reasonRef}
        name="customer-purge-reason"
        placeholder="例：买家 2026-10-09 邮件要求删除"
        value={reason}
        error={reasonError}
        onChange={(v) => {
          setReason(v);
          if (v.trim() !== '') setReasonError('');
        }}
      />
      <button
        type="button"
        className="btn btn-danger-outline btn-fit"
        disabled={busy}
        onClick={ask}
      >
        删除行为记录
      </button>
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
