/**
 * 职责：**全局停售开关**面板（AJ-384；工程缺口第二轮 §6.3 G10）。
 *
 * @why 事故止血（价格录错、库存错乱）要能一键做到，且不需要发版或重启。开 / 关都要填原因（进审计）、两步确认。
 * @why 停售中整块标红并放在运营配置页最上面：开着忘了关，等于店一直关门——要让它显眼到不可能忽略。
 * @why 提交时发的是**操作者选定的目标值**，且 PUT 之前**重新取一次当前状态**（第三轮缺口 P2-48）：
 *      旧实现发 `paused: !paused`，`paused` 来自打开页面时的快照——另一位管理员刚暂停过，
 *      这边点"暂停接单"实际发出的是"恢复"。现在按钮文字就是目标，取到的当前值已等于目标就不发，
 *      明说"已经是该状态（可能刚被其他管理员修改）"并刷新显示。
 * @limitation 取数与 PUT 之间仍有极短窗口（不是原子的比较并交换；服务端没有版本号）。
 *             两个人在同一秒反向操作的概率可以忽略；发出去的仍是明确目标值，不会"翻转"成反方向。
 * @limitation 停售只拦"新的钱"（报价 / 建单 / 发起支付）；回调、退款、发货照常，这里明说，免得运营以为全站停了。
 * @see server/src/app/sales-pause.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { formatJst } from '../format.js';
import type { AdminApi } from './api.js';

interface State {
  paused: boolean;
  reason?: string;
  actor?: string;
  updated_at?: string;
}

export function SalesPausePanel({ api }: { api: AdminApi }) {
  const [state, setState] = useState<State | null>(null);
  const [reason, setReason] = useState('');
  /** 两步确认的目标值（null = 未进入确认态）：点按钮那一刻按当时显示的状态选定，提交时不再取反。 */
  const [target, setTarget] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState((await api({ path: '/api/v1/admin/ops/sales-pause', method: 'GET' })) as State);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const paused = state?.paused === true;

  const submit = async (): Promise<void> => {
    if (target === null) return;
    if (reason.trim() === '') return setError('请填写原因（进审计台账）');
    setBusy(true);
    setError('');
    try {
      const current = (await api({
        path: '/api/v1/admin/ops/sales-pause',
        method: 'GET',
      })) as State;
      if ((current?.paused === true) === target) {
        setState(current);
        setTarget(null);
        setError('已经是该状态（可能刚被其他管理员修改）');
        return;
      }
      setState(
        (await api({
          path: '/api/v1/admin/ops/sales-pause',
          method: 'PUT',
          body: { paused: target, reason: reason.trim() },
        })) as State,
      );
      setReason('');
      setTarget(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">全局停售</h1>
      </header>
      {state === null ? (
        <p className="muted">加载中…</p>
      ) : paused ? (
        <p className="error">
          ⛔ 已暂停接单：买家无法报价、下单、付款。原因：{state.reason ?? '—'}（{state.actor ?? '—'}
          ，{formatJst(state.updated_at)}）
        </p>
      ) : (
        <p className="muted">
          正常接单。紧急情况（如价格录错）可在这里一键暂停；回调、退款、发货不受影响。
        </p>
      )}
      <div className="form">
        <input
          className="input"
          name="sales-pause-reason"
          placeholder={paused ? '恢复接单的原因' : '暂停接单的原因'}
          maxLength={ADMIN_NOTE_MAX_LENGTH}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {target !== null ? (
          <div className="row2">
            <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
              {busy ? '提交中…' : target ? '确认暂停接单' : '确认恢复接单'}
            </button>
            <button type="button" className="link" onClick={() => setTarget(null)}>
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={state === null}
            onClick={() => setTarget(!paused)}
          >
            {paused ? '恢复接单' : '暂停接单'}
          </button>
        )}
        {error !== '' && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
