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
import { FX_QUOTES, emptyFxForm, fxFormErrors, fxRows, toFxBody } from './view.js';

export interface FxPanelProps {
  api: AdminApi;
}

export function FxPanel({ api }: FxPanelProps) {
  const [rows, setRows] = useState<ReturnType<typeof fxRows>>([]);
  const [form, setForm] = useState(emptyFxForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(fxRows(await listFx(api)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    const check = fxFormErrors(form);
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setError('');
    setOk('');
    try {
      await setFx(api, toFxBody(form));
      setForm(emptyFxForm());
      setOk('已保存（新的展示价立即按新汇率计算）');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
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
        <button type="button" className="btn" onClick={() => void save()}>
          保存汇率
        </button>
      </div>

      {error !== '' && <p className="error">{error}</p>}
      {ok !== '' && <p className="ok">{ok}</p>}
    </section>
  );
}
