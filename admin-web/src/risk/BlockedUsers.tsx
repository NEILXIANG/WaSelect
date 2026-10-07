/**
 * 职责：风控页的**已拉黑用户**列表与解除拉黑（AJ-384；工程缺口第二轮 §6.3 G7）。
 *
 * @why 拉黑原先没有解除入口，误拉黑只能直接改库（绕过审计）。解除要求填原因、两步确认，与拉黑同等慎重。
 * @limitation 拉黑时被连带取消的在途单**不会恢复**（库存已回补，恢复会超卖）——这里明说，买家需重新下单。
 * @see server/src/app/admin-risk-routes.ts（unblock / GET users?blocked=true）
 */
import { useCallback, useEffect, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { formatJst } from '../format.js';
import { listBlockedUsers, unblockUser, type AdminApi, type BlockedUser } from './api.js';
import { blockedListTitle } from './view.js';

/**
 * @param refreshKey 变了就重新拉列表（P2-47）：风控页拉黑成功后递增它，新拉黑的人立刻出现在这里，
 *                   不用整页刷新——否则运营会以为拉黑没生效再点一次（第二次是 409/空操作，徒增审计噪音）。
 */
export function BlockedUsers({ api, refreshKey = 0 }: { api: AdminApi; refreshKey?: number }) {
  const [rows, setRows] = useState<BlockedUser[]>([]);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listBlockedUsers(api));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submit = async (): Promise<void> => {
    if (reason.trim() === '') return setError('请填写解除原因（进审计台账）');
    setBusy(true);
    setError('');
    try {
      await unblockUser(api, target, reason.trim());
      setTarget('');
      setReason('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
                <td className="selectable">{u.id}</td>
                <td>{formatJst(u.blocked_at)}</td>
                <td>{u.order_count} 单</td>
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
            placeholder="解除原因（进审计台账）"
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="row2">
            <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
              {busy ? '提交中…' : '确认解除'}
            </button>
            <button type="button" className="link" onClick={() => setTarget('')}>
              取消
            </button>
          </div>
        </div>
      )}
      {error !== '' && <p className="error">{error}</p>}
    </div>
  );
}
