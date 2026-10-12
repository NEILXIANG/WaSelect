/**
 * 职责：客户详情页的**拉黑 / 解除**（AJ-404：从风控页挪过来的主入口；风控页保留原入口）。
 *
 * @why 复用 `risk/api.ts` 的 `blockUser` / `unblockUser`：服务端是同一对接口（连带取消在途单、作废身份缓存都在那边），
 *      前端再包一份就会出现"两个入口发的请求体不一样"。
 * @why 这里拉黑**不带 order_id**：风控页带它，是为了核对"拒付那一单属于这个人"（ADM3-01）；
 *      客户页是从人出发的，没有"哪一单"可核——硬塞一张单号反而是在伪造凭据。
 * @why 成功后让父组件**重新取详情**（`onChanged`），不在本地把 blocked 翻成 true：以服务端为准（与订单详情 @limitation 一同口径）。
 * @limitation 拉黑 / 解除原因都必填、进审计（服务端 releaseReasonGuard，AJ-449）；这里只挡"空着"，长度上限复用 ADMIN_NOTE_MAX_LENGTH。
 * @see ../risk/RiskPage.tsx；../risk/BlockedUsers.tsx（同一套确认弹层与 Toast）
 */
import { useRef, useState } from 'react';
import { ReasonInput } from '../ui/ReasonInput.js';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { toastError, type ToastSink } from '../ui/toast.js';
import { blockUser, unblockUser } from '../risk/api.js';
import type { AdminApi } from './api.js';
import { CUSTOMER_BLOCK_CONFIRM_TEXT } from './view.js';

export interface CustomerRiskActionsProps {
  api: AdminApi;
  userId: string;
  /** 客户称呼（收件人 / 邮箱）：确认弹层与提示里写它，不写 36 位 id（全入口点击测试 2026-10-12）。 */
  customerName: string;
  blocked: boolean;
  sink: ToastSink;
  onChanged: () => Promise<unknown>;
}

export function CustomerRiskActions({
  api,
  userId,
  customerName,
  blocked,
  sink,
  onChanged,
}: CustomerRiskActionsProps) {
  const [reason, setReason] = useState('');
  /** 没填原因时标在框下的提示（ReasonInput）。 */
  const [reasonError, setReasonError] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const who = customerName !== '' ? customerName : '该客户';
  const missing = (text: string): void => {
    setReasonError(text);
    reasonRef.current?.focus();
  };
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<(ConfirmSpec & { run: () => Promise<void> }) | null>(null);

  const run = async (fn: () => Promise<void>, done: string, fail: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setDialog(null);
      await onChanged();
      sink.success(done);
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, fail);
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  const askBlock = (): void => {
    const r = reason.trim();
    if (r === '') return missing('请填写拉黑原因（会记录下来）');
    setDialog({
      title: '拉黑后客户无法再下单（这次操作会记录下来）',
      body: `${CUSTOMER_BLOCK_CONFIRM_TEXT}\n\n客户：${who}\n原因：${r}`,
      confirmText: '确认拉黑',
      danger: true,
      run: () =>
        run(
          async () => {
            await blockUser(api, { userId, reason: r });
            setReason('');
          },
          `已拉黑 ${who}：此后无法下单；其名下未付款订单已一并取消`,
          '拉黑失败',
        ),
    });
  };

  const askUnblock = (): void => {
    const r = reason.trim();
    if (r === '') return missing('请填写解除原因（会记录下来）');
    setDialog({
      title: '解除后对方重新登录即可下单',
      body: `客户：${who}。拉黑时被取消的订单不会恢复（库存已回补，恢复会超卖），买家需重新下单。解除原因会记录下来。`,
      confirmText: '确认解除',
      danger: true,
      run: () =>
        run(
          async () => {
            await unblockUser(api, userId, r);
            setReason('');
          },
          `已解除 ${who} 的拉黑：对方重新登录即可下单`,
          '解除拉黑失败',
        ),
    });
  };

  return (
    <div className="form">
      {blocked ? (
        <>
          <ReasonInput
            ref={reasonRef}
            name="customer-unblock-reason"
            placeholder="例：客服核实为误拉黑"
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
            onClick={askUnblock}
          >
            解除拉黑
          </button>
        </>
      ) : (
        <>
          <ReasonInput
            ref={reasonRef}
            name="customer-block-reason"
            placeholder="拉黑原因（必填，会记录下来），例：同一张卡 30 天内 3 次拒付"
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
            onClick={askBlock}
          >
            拉黑该客户
          </button>
        </>
      )}
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => void dialog.run()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
