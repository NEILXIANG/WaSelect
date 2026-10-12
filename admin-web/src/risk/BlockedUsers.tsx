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
import { ConfirmDialog, type ConfirmSpec } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts, type ToastSink } from '../ui/toast.js';
import { formatJst, shortRef } from '../format.js';
import { listBlockedUsers, unblockUser, type AdminApi, type BlockedUser } from './api.js';
import { blockedListTitle } from './view.js';
import { ReasonInput } from '../ui/ReasonInput.js';

/**
 * @param refreshKey 变了就重新拉列表（P2-47）：风控页拉黑成功后递增它，新拉黑的人立刻出现在这里，
 *                   不用整页刷新——否则运营会以为拉黑没生效再点一次（第二次是 409/空操作，徒增审计噪音）。
 */
export function BlockedUsers({
  api,
  refreshKey = 0,
  onChanged,
  sink: parentSink,
}: {
  api: AdminApi;
  refreshKey?: number;
  /**
   * 父页的 Toast 出口（审查 2026-10-09 #7）：风控页自己也挂了一个 ToastStack，两个都固定在右下角会重叠，
   * 且"已拉黑 A"与"已解除 A"会同屏。传入后本组件不再自渲染浮层，成功提示走父页（success 会清屏）。
   */
  sink?: ToastSink | undefined;
  /** 解除成功后通知父页（清掉父页上"已拉黑 …"的旧提示，三端联动 UI 模拟 2026-10-08）。 */
  onChanged?: (() => void) | undefined;
}) {
  const [rows, setRows] = useState<BlockedUser[]>([]);
  const [target, setTarget] = useState('');
  /** 解除对象的称呼（收件人 · 邮箱；都没有时缩短 id）——提示里写它，不写 36 位 id（全入口点击测试 2026-10-12）。 */
  const [targetName, setTargetName] = useState('');
  const [reason, setReason] = useState('');
  /** 没填原因时标在框下的提示（与客户页同一做法，第三轮走查 2026-10-12）。 */
  const [reasonError, setReasonError] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  /** 换对象 / 收起：原因与提示一并清空——不然下一个人的框里是上一个人的原因。 */
  const pick = (id: string, name: string): void => {
    setTarget(id);
    setTargetName(name);
    setReason('');
    setReasonError('');
  };
  const [busy, setBusy] = useState(false);
  const ownSink = useToasts();
  const sink = parentSink ?? ownSink;
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
      setReasonError('请填写解除原因（会记录下来）');
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
      sink.success(`已解除 ${targetName} 的拉黑：对方重新登录即可下单`);
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
      setReasonError('请填写解除原因（会记录下来）');
      reasonRef.current?.focus();
      return;
    }
    dialogRun.current = () => void submit();
    setDialog({
      title: '解除后对方重新登录即可下单',
      body: `${targetName}。拉黑时被取消的订单不会恢复（库存已回补，恢复会超卖），买家需重新下单。解除原因会记录下来。`,
      confirmText: '确认解除',
      danger: true,
    });
  };

  return (
    <div className="form">
      {/* 一节的标题（全入口点击测试 2026-10-12：原为灰色小字，与上面的拒付表分不开） */}
      <h2 className="title">{blockedListTitle(rows.length)}</h2>
      {rows.length === 0 ? (
        <p className="muted">没有被拉黑的用户</p>
      ) : (
        <table className="table">
          {/* 表头（全入口点击测试 2026-10-12：原先没有，"3 单"与时间不知道是什么） */}
          <thead>
            <tr>
              <th>客户</th>
              <th>拉黑时间（日本时间）</th>
              <th>订单数</th>
              <th colSpan={2}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td className="selectable">
                  {u.last_recipient ?? '（无订单）'}
                  {u.last_contact_email !== undefined ? ` · ${u.last_contact_email}` : ''}
                  {/* 三端模拟测试 2026-10-11（用户要求）：有名字 / 邮箱就不拼 36 位 id（运营读不懂）；
                      都没有时给缩短 id 认人，全文悬停可见。完整 id 在客户详情里 */}
                  {u.last_recipient === undefined && u.last_contact_email === undefined && (
                    <span className="muted" title={u.id}>
                      {' '}
                      · {shortRef(u.id)}
                    </span>
                  )}
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
                  <button
                    type="button"
                    className="link"
                    onClick={() => pick(u.id, blockedUserName(u))}
                  >
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
            解除 {targetName}{' '}
            的拉黑：对方重新登录即可下单；拉黑时被取消的订单不会恢复（库存已回补）。
          </p>
          <ReasonInput
            ref={reasonRef}
            name="unblock-reason"
            placeholder="例：核实是误拉黑，已与买家确认"
            value={reason}
            onChange={(v) => {
              setReason(v);
              if (v.trim() !== '') setReasonError('');
            }}
            error={reasonError}
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
          <button type="button" className="link" onClick={() => pick('', '')}>
            取消
          </button>
        </div>
      )}

      {parentSink === undefined && <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />}
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

/** 列表行 → 称呼（收件人 · 邮箱；都没有时缩短 id）。与表格第一列同一口径。 */
function blockedUserName(u: {
  id: string;
  last_recipient?: string | undefined;
  last_contact_email?: string | undefined;
}): string {
  const parts = [u.last_recipient, u.last_contact_email].filter(
    (x): x is string => typeof x === 'string' && x !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : `客户 ${shortRef(u.id)}`;
}
