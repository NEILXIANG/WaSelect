/**
 * 职责：风控页的**已拉黑用户**列表与解除拉黑（AJ-384；工程缺口第二轮 §6.3 G7）。
 *
 * @why 拉黑原先没有解除入口，误拉黑只能直接改库（绕过审计）。解除要求填原因、两步确认，与拉黑同等慎重。
 * @limitation 拉黑时被连带取消的在途单**不会恢复**（库存已回补，恢复会超卖）——这里明说，买家需重新下单。
 * @limitation 第一批①（2026-10-08）：解除确认走 `ui/ConfirmDialog`，反馈走 `ui/Toast`。
 *             解除与拉黑同样是"改动一个风控事实"，却不像拉黑那样显眼——
 *             把它做成同款弹层，是为了让"撤销风控决定"和"作出风控决定"在手上一样重。
 * @see server/src/app/admin-risk-routes.ts（unblock / GET users?blocked=true）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { formatJst } from '../format.js';
import { listBlockedUsers, unblockUser, type AdminApi, type BlockedUser } from './api.js';
import { blockedListTitle } from './view.js';

/**
 * @param refreshKey 变了就重新拉列表（P2-47）：风控页拉黑成功后递增它，新拉黑的人立刻出现在这里，
 *                   不用整页刷新——否则运营会以为拉黑没生效再点一次（第二次是 409/空操作，徒增审计噪音）。
 */
export function BlockedUsers({
  api,
  refreshKey = 0,
  onChanged,
}: {
  api: AdminApi;
  refreshKey?: number;
  /** 解除成功后通知父页（清掉父页上"已拉黑 …"的旧提示，三端联动 UI 模拟 2026-10-08）。 */
  onChanged?: (() => void) | undefined;
}) {
  const [rows, setRows] = useState<BlockedUser[]>([]);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const sink = useToasts();
  /** 解除确认弹层（null = 没开）。 */
  const [dialog, setDialog] = useState<ConfirmSpec | null>(null);
  /** 弹层确认后要跑的动作（与订单详情同口径：函数不进 state）。 */
  const dialogRun = useRef<() => void>(() => undefined);

  const load = useCallback(async () => {
    try {
      setRows(await listBlockedUsers(api));
    } catch (e) {
      const { text, traceId } = toastError(e, '取已拉黑用户失败');
      sink.error(text, { traceId });
    }
  }, [api, sink.error]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submit = async (): Promise<void> => {
    if (reason.trim() === '') {
      sink.error('请填写解除原因（会记录下来）');
      setDialog(null);
      return;
    }
    setBusy(true);
    try {
      await unblockUser(api, target, reason.trim());
      setTarget('');
      setReason('');
      setDialog(null);
      onChanged?.();
      await load();
      sink.success(`已解除 ${target} 的拉黑：对方重新登录即可下单`);
    } catch (e) {
      setDialog(null);
      const { text, traceId } = toastError(e, '解除拉黑失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  const askUnblock = (): void => {
    if (reason.trim() === '') {
      sink.error('请填写解除原因（会记录下来）');
      return;
    }
    dialogRun.current = () => void submit();
    setDialog({
      title: '解除后对方重新登录即可下单',
      body: `${target}。拉黑时被取消的订单不会恢复（库存已回补，恢复会超卖），买家需重新下单。解除原因会记录下来。`,
      confirmText: '确认解除',
      danger: true,
    });
  };

  return (
    <div className="form">
      <span className="label">{blockedListTitle(rows.length)}</span>
      {rows.length === 0 ? (
        <p className="muted">没有被拉黑的用户</p>
      ) : (
        <table className="table">
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td className="selectable">
                  {u.last_recipient ?? '（无订单）'}
                  {u.last_contact_email !== undefined ? ` · ${u.last_contact_email}` : ''}
                  <span className="muted"> · {u.id}</span>
                </td>
                <td>{formatJst(u.blocked_at)}</td>
                <td>{u.order_count} 单</td>
                <td>
                  {/* AJ-404：拉黑 / 解除的主入口已挪到客户详情；这里保留解除，并链过去看全貌 */}
                  <a className="link" href={`#/customers/${encodeURIComponent(u.id)}`}>
                    客户详情
                  </a>
                </td>
                <td>
                  <button type="button" className="link" onClick={() => setTarget(u.id)}>
                    解除拉黑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {target !== '' && (
        <div className="form">
          <p className="muted">
            解除 {target}：对方重新登录即可下单；拉黑时被取消的订单不会恢复（库存已回补）。
          </p>
          <input
            className="input"
            name="unblock-reason"
            placeholder="例：核实是误拉黑，已与买家确认"
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {/*
            按钮文字用「去确认」而不是再来一个「解除拉黑」：
            列表行上已经有一个同名按钮了，同屏两个「解除拉黑」时
            运营（和组件用例按文字找按钮的测试）都分不清哪个是入口、哪个是提交。
            第一批① 才暴露出来——此前这颗按钮自己就是最后一道确认，没人需要区分。
          */}
          <button type="button" className="btn btn-danger" disabled={busy} onClick={askUnblock}>
            去确认
          </button>
          <button type="button" className="link" onClick={() => setTarget('')}>
            取消
          </button>
        </div>
      )}

      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      {dialog !== null && (
        <ConfirmDialog
          spec={dialog}
          busy={busy}
          onConfirm={() => dialogRun.current()}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
