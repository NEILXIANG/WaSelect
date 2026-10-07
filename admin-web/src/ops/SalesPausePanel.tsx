/**
 * 职责：**全局停售开关**面板（AJ-384；工程缺口第二轮 §6.3 G10）。
 *
 * @why 事故止血（价格录错、库存错乱）要能一键做到，且不需要发版或重启。开 / 关都要填原因（进审计）、两步确认。
 * @why 停售中整块标红并放在运营配置页最上面：开着忘了关，等于店一直关门——要让它显眼到不可能忽略。
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
  const [confirming, setConfirming] = useState(false);
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
    if (reason.trim() === '') return setError('请填写原因（进审计台账）');
    setBusy(true);
    setError('');
    try {
      setState(
        (await api({
          path: '/api/v1/admin/ops/sales-pause',
          method: 'PUT',
          body: { paused: !paused, reason: reason.trim() },
        })) as State,
      );
      setReason('');
      setConfirming(false);
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
        {confirming ? (
          <div className="row2">
            <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
              {busy ? '提交中…' : paused ? '确认恢复接单' : '确认暂停接单'}
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={state === null}
            onClick={() => setConfirming(true)}
          >
            {paused ? '恢复接单' : '暂停接单'}
          </button>
        )}
        {error !== '' && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
