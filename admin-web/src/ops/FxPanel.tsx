/**
 * 职责：展示汇率面板（列表 + 维护）。
 *
 * @why 单独成组件：汇率与运费分档是两张互不相干的表，
 *      塞进同一页会让"保存"按钮的语义变模糊（保存哪一张？）。
 *
 * @limitation 一：`effective_from` 用 `datetime-local` 输入，按 **JST** 解释后
 *              转成带 `+09:00` 的 ISO——与管理端所有时间显示口径一致
 *              （@see ../format.ts @limitation 二）。留空 = 立即生效（契约可选项）。
 * @limitation 二：列表显示服务端返回的**全部行**（历史 + 尚未生效的，按生效时间倒序）；
 *              "当前生效"是其中不晚于此刻的最新一行（@see ./view.ts `currentFxRawRates`）。
 *              此处曾写"服务端只返回当前生效一条"——与实现不符，且正是量级核对取错基准的成因（AJ-229）。
 *              "改错了"只能再提交一条新的覆盖，页面不提供"删除"。
 * @limitation 三：保存前的核对是**前端**的闸（@see ./view.ts `fxSaveStep` @limitation）。
 *
 * @limitation 四：保存的成败与"格式不对"走 `ui/Toast`（审查 2026-10-09）；输入框下方的「核对：…」是
 *              **保存前的闸门说明**（与输入值逐字联动），仍留在行内。
 *
 * @see ./view.ts（校验与请求体）；./api.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { ToastStack, toastError, useToasts, type ToastSink } from '../ui/toast.js';
import { useFormDirty } from '../ui/unsaved.js';
import { listFx, setFx, type AdminApi } from './api.js';
import { currencyName } from '../orders/partial-refund-view.js';
import {
  FX_QUOTES,
  currentFxRawRates,
  emptyFxForm,
  fxFormKey,
  fxPreview,
  fxRows,
  fxSaveStep,
  fxSavedText,
  toFxBody,
} from './view.js';

export interface FxPanelProps {
  api: AdminApi;
  /** 父页（OpsPage）的 Toast 出口：传入后本面板不自渲染浮层（三个面板共用一摞，@see ./OpsPage.tsx）。 */
  sink?: ToastSink | undefined;
}

export function FxPanel({ api, sink: parentSink }: FxPanelProps) {
  const [rows, setRows] = useState<ReturnType<typeof fxRows>>([]);
  /**
   * 各币种**当前生效**的原始汇率（数值），只用于保存前的倍数核对（取法见 `currentFxRawRates`）。
   * @why `fxRows` 只输出展示文本（`rateText`），而"新值是旧值的几倍"必须用数值算；
   *      把数值塞进 `fxRows` 的返回会改变它的输出形状（它的用例是逐字段断言的），
   *      所以在面板里另存一份原始值——它不是展示数据，是核对用的输入。
   */
  const [currentRates, setCurrentRates] = useState<Record<string, number>>({});
  const [form, setForm] = useState(emptyFxForm);
  useFormDirty(form, emptyFxForm()); // G2（AJ-477）：填了一半切页签要有提醒
  const [loading, setLoading] = useState(false);
  const ownSink = useToasts();
  const sink = parentSink ?? ownSink;
  /**
   * 确认与勾选各自绑定的**表单指纹**（AJ-229）：不是布尔。
   * 表单一变指纹就变，下面派生出的 `confirming` / `ack` 自动变回 false——
   * 不存在"改了值却忘了复位确认"这种状态。
   */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [ackKey, setAckKey] = useState<string | null>(null);
  /**
   * 提交中（ADM3-04）。
   * @why 没有它时，"确认保存"连点两下就发出两笔 POST：第一笔用了当前时刻、第二笔也用当前时刻，
   *      而 `UNIQUE(quote, effective_from)` 让其中一笔 40910；更常见的是先存了一笔错的、
   *      再存一笔对的，两边都留下审计记录，"当时到底存了几次"从此说不清。
   *      双击是运营改主意时最常见的动作，不能靠"手别抖"。
   */
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    sink.error('');
    try {
      const list = await listFx(api);
      setRows(fxRows(list));
      // ⚠️ 不传本机时钟：`is_current` 由服务端按自己的时钟判定（ADM3-05），见 view.ts 的 @why
      setCurrentRates(currentFxRawRates(list));
    } catch (e) {
      const { text, traceId } = toastError(e, '汇率列表加载失败');
      sink.error(text, { traceId });
    } finally {
      setLoading(false);
    }
  }, [api, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentRate = currentRates[form.quote] ?? null;
  const preview = fxPreview({ quote: form.quote, rawRate: form.rawRate, currentRate });
  const formKey = fxFormKey(form);
  const confirming = confirmKey === formKey;
  const ack = ackKey === formKey;
  const step = fxSaveStep({ form, currentRate, confirmKey, ackKey });
  /**
   * 填写错误标在按钮旁（规律排查 2026-10-12：原先只进右下角浮层）；按表单键记，改了任何一格就自动消失。
   */
  const [invalid, setInvalid] = useState<{ key: string; message: string } | null>(null);
  const invalidText = invalid !== null && invalid.key === formKey ? invalid.message : '';

  const save = async (): Promise<void> => {
    sink.error('');
    sink.success('');
    setSaving(true);
    try {
      await setFx(api, toFxBody(form));
      sink.success(fxSavedText(form));
      setForm(emptyFxForm());
      await load();
    } catch (e) {
      const { text, traceId } = toastError(e, '汇率保存失败');
      sink.error(text, { traceId });
    } finally {
      setSaving(false);
      setConfirmKey(null);
      setAckKey(null);
    }
  };

  /**
   * "保存汇率"与"确认保存"共用这一个入口：每次都按**此刻的表单**重新过一遍 `fxSaveStep`。
   * @why 展示汇率直接乘进真实扣款额（`pay-intent.ts` 的 `resolveCharge`）：
   *      录成 0.00067 → 每笔美元订单少收 90%；录成 150 → 多收两万倍、引来拒付。
   *      两种情况在提交时**都不报错**，所以只能在这个按钮上拦（全量审查 A8）。
   * @why 确认按钮也走它（AJ-229）：原先确认按钮直接调 `save()`，不再校验——
   *      勾选之后改值就绕过了全部核对。
   */
  const attempt = (): void => {
    if (saving) return; // 连点保护（ADM3-04）：按钮的 disabled 之外再兜一次
    if (step.kind === 'invalid') {
      setInvalid({ key: formKey, message: step.message });
      return;
    }
    if (step.kind === 'confirm') {
      sink.error('');
      setConfirmKey(formKey);
      return;
    }
    void save();
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="title">展示汇率</h2>
        {loading && <span className="muted">加载中…</span>}
      </header>

      <table className="table">
        <thead>
          <tr>
            <th>币种</th>
            <th>生效汇率</th>
            <th>原始汇率</th>
            <th>缓冲</th>
            <th>折算示例</th>
            <th>生效时间（日本时间）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{currencyName(r.quote)}</td>
              <td>{r.rateText}</td>
              <td>{r.rawRateText}</td>
              <td className="muted">{r.bufferText}</td>
              <td>{r.exampleText}</td>
              {/* ⚠️ "当前生效"由服务端标（ADM3-05）：这张表是只能追加的历史视图，
                  不标的话运营只能靠生效时间去推哪一行正在起作用（ADM-10）。 */}
              <td className={r.stale ? 'error' : 'muted'}>
                {r.effectiveText}
                {r.currentNote}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={6}>
                还没有配置汇率（展示价会算不出来）
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="form">
        <span className="label">维护汇率</span>
        <div className="row2">
          <select
            className="input"
            value={form.quote}
            onChange={(e) => setForm((s) => ({ ...s, quote: e.target.value }))}
          >
            {FX_QUOTES.map((q) => (
              <option key={q} value={q}>
                {currencyName(q)}
              </option>
            ))}
          </select>
          <input
            className="input"
            aria-label="原始汇率"
            placeholder="原始汇率（如 0.0067）"
            value={form.rawRate}
            onChange={(e) => setForm((s) => ({ ...s, rawRate: e.target.value }))}
          />
          <input
            className="input"
            type="datetime-local"
            aria-label="生效时间（日本时间，空着表示立即）"
            value={form.effectiveFrom}
            onChange={(e) => setForm((s) => ({ ...s, effectiveFrom: e.target.value }))}
          />
        </div>
        <p className="muted">生效时间留空 = 立即生效；填写的时间按日本时间算</p>
        {preview.sampleText !== '' && (
          <p className={preview.risky || preview.noBaseline ? 'error' : 'muted'}>
            核对：{preview.sampleText}
            {preview.reason !== '' ? `（${preview.reason}）` : ''}
          </p>
        )}
        {confirming ? (
          <div className="row2">
            {/* ⚠️ 渲染条件是"这笔值要不要勾"（`requireAck`），不是"当前处于哪一步"（`kind`）：
                勾选会让 `kind` 变成 `save`，按 `kind === 'confirm'` 渲染的旧写法会让复选框
                勾完就消失——运营想撤回勾选再核对一遍时找不到它（ADM3-03）。 */}
            {step.kind !== 'invalid' && step.requireAck && (
              <label className="label">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAckKey(e.target.checked ? formKey : null)}
                />
                我已核对上面的金额，确认不是小数点错位
              </label>
            )}
            <button
              type="button"
              className="btn"
              disabled={saving || (step.kind !== 'invalid' && step.requireAck && !ack)}
              onClick={attempt}
            >
              {saving ? '保存中…' : `确认保存（${currencyName(form.quote)}）`}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setConfirmKey(null);
                setAckKey(null);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={attempt}>
            保存汇率
          </button>
        )}
        {invalidText !== '' && (
          <p className="error" role="alert">
            {invalidText}
          </p>
        )}
      </div>

      {parentSink === undefined && <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />}
    </section>
  );
}
