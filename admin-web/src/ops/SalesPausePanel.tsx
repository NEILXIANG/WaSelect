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
 * @limitation 操作反馈（取数失败 / 缺原因 / 已是该状态 / 提交失败）走 `ui/Toast`（审查 2026-10-09）；
 *             顶部那条红色「⛔ 已暂停接单」是**状态显示**不是反馈，保持原样常驻。
 * @see server/src/app/sales-pause.ts
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ADMIN_NOTE_MAX_LENGTH } from '@waselect/shared';
import { formatJst } from '../format.js';
import { ToastStack, toastError, useToasts, type ToastSink } from '../ui/toast.js';
import { useFormDirty } from '../ui/unsaved.js';
import type { AdminApi } from './api.js';

interface State {
  paused: boolean;
  reason?: string;
  actor?: string;
  /** 操作人邮箱（服务端按 actor 查得；三端联动模拟 2026-10-08）。 */
  actor_email?: string;
  updated_at?: string;
}

export function SalesPausePanel({
  api,
  sink: parentSink,
}: {
  api: AdminApi;
  /** 父页（OpsPage）的 Toast 出口：传入后本面板不自渲染浮层（三个面板共用一摞，@see ./OpsPage.tsx）。 */
  sink?: ToastSink | undefined;
}) {
  const [state, setState] = useState<State | null>(null);
  const [reason, setReason] = useState('');
  useFormDirty(reason, ''); // G2（AJ-477）
  /** 两步确认的目标值（null = 未进入确认态）：点按钮那一刻按当时显示的状态选定，提交时不再取反。 */
  const [target, setTarget] = useState<boolean | null>(null);
  const ownSink = useToasts();
  const sink = parentSink ?? ownSink;
  const [busy, setBusy] = useState(false);
  /** 第一步没填原因时标在输入框下（全入口点击测试 2026-10-12：原先进了确认态、点确认才在右下角浮层说缺原因）。 */
  const [reasonMissing, setReasonMissing] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);

  /** 第一步：没填原因就拦在这一步（同拉黑 AJ-449），填了才进两步确认。 */
  const ask = (next: boolean): void => {
    if (reason.trim() === '') {
      setReasonMissing(true);
      reasonRef.current?.focus();
      return;
    }
    setTarget(next);
  };

  const load = useCallback(async () => {
    try {
      setState((await api({ path: '/api/v1/admin/ops/sales-pause', method: 'GET' })) as State);
    } catch (e) {
      const { text, traceId } = toastError(e, '停售状态加载失败');
      sink.error(text, { traceId });
    }
  }, [api, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const paused = state?.paused === true;

  const submit = async (): Promise<void> => {
    if (target === null) return;
    if (reason.trim() === '') return sink.error('请填写原因（会记录下来）');
    setBusy(true);
    sink.error('');
    try {
      const current = (await api({
        path: '/api/v1/admin/ops/sales-pause',
        method: 'GET',
      })) as State;
      if ((current?.paused === true) === target) {
        setState(current);
        setTarget(null);
        sink.error('已经是该状态（可能刚被其他管理员修改）');
        return;
      }
      const written = (await api({
        path: '/api/v1/admin/ops/sales-pause',
        method: 'PUT',
        body: { paused: target, reason: reason.trim() },
      })) as State;
      // 再取一次：GET 才带操作人邮箱（actor_email）；取失败就用 PUT 的回包，不让状态行空着
      setState(
        ((await api({ path: '/api/v1/admin/ops/sales-pause', method: 'GET' }).catch(
          () => written,
        )) as State) ?? written,
      );
      setReason('');
      setTarget(null);
    } catch (e) {
      const { text, traceId } = toastError(e, '停售开关提交失败');
      sink.error(text, { traceId });
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
          ⛔ 已暂停接单：买家无法报价、下单、付款。原因：{state.reason ?? '—'}（
          {state.actor_email ?? state.actor ?? '—'}，{formatJst(state.updated_at)}）
        </p>
      ) : (
        <p className="muted">
          正常接单。紧急情况（如价格录错）可在这里一键暂停；回调、退款、发货不受影响。
        </p>
      )}
      <div className="form">
        <div className="field">
          <input
            ref={reasonRef}
            className="input"
            name="sales-pause-reason"
            placeholder={paused ? '恢复接单的原因' : '暂停接单的原因'}
            maxLength={ADMIN_NOTE_MAX_LENGTH}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (e.target.value.trim() !== '') setReasonMissing(false);
            }}
          />
          {reasonMissing && (
            <span className="error" role="alert">
              请填写原因（会记录下来）
            </span>
          )}
        </div>
        {target !== null ? (
          <div className="row2">
            {/* 确认暂停是实心危险按钮（店会关门）；确认恢复是普通主按钮 */}
            <button
              type="button"
              className={target ? 'btn btn-danger' : 'btn'}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '提交中…' : target ? '确认暂停接单' : '确认恢复接单'}
            </button>
            <button type="button" className="link" onClick={() => setTarget(null)}>
              取消
            </button>
          </div>
        ) : (
          // 按内容宽、暂停用危险描边（原为整行黑色主按钮：页面上最显眼的是"把店关掉"，像这页的主要动作）
          <button
            type="button"
            className={paused ? 'btn btn-fit' : 'btn btn-danger-outline btn-fit'}
            disabled={state === null}
            onClick={() => ask(!paused)}
          >
            {paused ? '恢复接单' : '暂停接单'}
          </button>
        )}
      </div>
      {parentSink === undefined && <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />}
    </section>
  );
}
