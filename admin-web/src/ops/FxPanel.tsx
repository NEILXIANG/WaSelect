/**
 * 职责：展示汇率面板（列表 + 维护）。
 *
 * @why 单独成组件：汇率与运费分档是两张互不相干的表，
 *      塞进同一页会让"保存"按钮的语义变模糊（保存哪一张？）。
 *
 * @limitation 一：`effective_from` 用 `datetime-local` 输入，按 **JST** 解释后
 *              转成带 `+09:00` 的 ISO——与管理端所有时间显示口径一致
 *              （@see ../format.ts @limitation 二）。留空 = 立即生效（契约可选项）。
 * @limitation 二：列表显示的是"当前生效"的汇率（服务端按 `effective_from <= now`
 *              取最新一条），**没有历史列表接口**；所以"改错了"只能再提交一条新的覆盖，
 *              页面不提供"删除"。
 *
 * @see ./view.ts（校验与请求体）；./api.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { listFx, setFx, type AdminApi } from './api.js';
import { FX_QUOTES, emptyFxForm, fxFormErrors, fxPreview, fxRows, toFxBody } from './view.js';

export interface FxPanelProps {
  api: AdminApi;
}

export function FxPanel({ api }: FxPanelProps) {
  const [rows, setRows] = useState<ReturnType<typeof fxRows>>([]);
  /**
   * 各币种**当前生效**的 rate（数值），只用于保存前的倍数核对。
   * @why `fxRows` 只输出展示文本（`rateText`），而"新值是旧值的几倍"必须用数值算；
   *      把数值塞进 `fxRows` 的返回会改变它的输出形状（它的用例是逐字段断言的），
   *      所以在面板里另存一份原始值——它不是展示数据，是核对用的输入。
   */
  const [currentRates, setCurrentRates] = useState<Record<string, number>>({});
  const [form, setForm] = useState(emptyFxForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  /** 已进入二次确认态（只在"量级可疑"时为真）。 */
  const [confirming, setConfirming] = useState(false);
  /** 确认态下的勾选（"我核对过了"）。 */
  const [ack, setAck] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await listFx(api);
      setRows(fxRows(list));
      const rates: Record<string, number> = {};
      for (const x of Array.isArray(list) ? list : []) {
        const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
        const q = typeof o['quote'] === 'string' ? o['quote'] : '';
        const r = Number(o['rate']);
        if (q !== '' && Number.isFinite(r) && r > 0) rates[q] = r;
      }
      setCurrentRates(rates);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = fxPreview({
    quote: form.quote,
    rawRate: form.rawRate,
    currentRate: currentRates[form.quote] ?? null,
  });

  const save = async (): Promise<void> => {
    setError('');
    setOk('');
    try {
      await setFx(api, toFxBody(form));
      setForm(emptyFxForm());
      setOk('已保存（新的展示价立即按新汇率计算）');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setConfirming(false);
      setAck(false);
    }
  };

  /**
   * 点"保存汇率"：先形状校验，再看**量级**——量级可疑时不直接提交，先要一次确认。
   * @why 展示汇率直接乘进真实扣款额（`pay-intent.ts` 的 `resolveCharge`）：
   *      录成 0.00067 → 每笔美元订单少收 90%；录成 150 → 多收两万倍、引来拒付。
   *      两种情况在提交时**都不报错**，所以只能在这个按钮上拦一道（全量审查 A8）。
   */
  const requestSave = (): void => {
    const check = fxFormErrors(form);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    if (preview.risky) {
      setConfirming(true);
      setAck(false);
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
            <th>生效时间（JST）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.quote}>
              <td>{r.quote}</td>
              <td>{r.rateText}</td>
              <td>{r.rawRateText}</td>
              <td className="muted">{r.bufferText}</td>
              <td className="muted">{r.effectiveText}</td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={5}>
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
                {q}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="原始汇率（如 0.0067）"
            value={form.rawRate}
            onChange={(e) => setForm((s) => ({ ...s, rawRate: e.target.value }))}
          />
          <input
            className="input"
            type="datetime-local"
            value={form.effectiveFrom}
            onChange={(e) => setForm((s) => ({ ...s, effectiveFrom: e.target.value }))}
          />
        </div>
        <p className="muted">生效时间留空 = 立即生效；填写时按 JST 解释</p>
        {preview.sampleText !== '' && (
          <p className={preview.risky ? 'error' : 'muted'}>
            核对：{preview.sampleText}
            {preview.reason !== '' ? `（${preview.reason}）` : ''}
          </p>
        )}
        {confirming ? (
          <div className="row2">
            <label className="label">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我已核对上面的金额，确认不是小数点错位
            </label>
            <button type="button" className="btn" disabled={!ack} onClick={() => void save()}>
              确认保存（{form.quote}）
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirming(false);
                setAck(false);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={requestSave}>
            保存汇率
          </button>
        )}
      </div>

      {error !== '' && <p className="error">{error}</p>}
      {ok !== '' && <p className="ok">{ok}</p>}
    </section>
  );
}
