/**
 * 职责：运费分档面板（可编辑表格 + 整表替换保存）。
 *
 * @why 保存要**二次确认**并明确写"用当前 N 档替换全部"：
 *      `PUT /admin/shipping-rates` 是整表替换（契约明文），
 *      没有"改一档"的接口——误点一次就把别人刚加的档位抹掉，
 *      而 UI 上只看到"保存成功"，要等下一次报价失败才发现。
 *
 * @why 表格按重量上限**升序展示**：分档表的语义就是"从轻到重"，
 *      乱序时运营看不出"这一档的上限比上一档还小"——而那正是取档会静默错的原因
 *      （@see ./view.ts 文件头的 D-46 说明）。
 *
 * @limitation 一：**不提供"输入重量试算运费"**（view.ts 文件头已写明理由）：
 *              那会在仓库里造出第二份取档实现，而 D-46 的教训就是"方向错了还静默"。
 * @limitation 二：`active` 用勾选框而不是删除：停用是"暂时不参与取档"，
 *              删除是"整表替换时不再提交"——后者不可逆（没有历史接口）。
 *
 * @see ./view.ts（整表校验）；./api.ts；server/src/adapters/catalog.ts（取档唯一实现）
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { listShippingRates, replaceShippingRates, type AdminApi } from './api.js';
import { emptyRateRow, rateDuplicates, rateErrors, toRateBody, type RateRow } from './view.js';

export interface RatesPanelProps {
  api: AdminApi;
}

export function RatesPanel({ api }: RatesPanelProps) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * 列表**至少成功加载过一次**（AJ-232）。在那之前表格里的"空"不代表"没有档位"，
   * 只代表"没取到"——此时放开编辑，保存就是拿一张空表去整表替换线上的真实运费表。
   * @why 只禁用"新增一档"这一个入口就够：没加载成功时表格是空的，空表过不了 `rateErrors`，
   *      "保存"本来就是禁用的；能把空表变成可保存的唯一动作是新增行。
   *      （给保存按钮再加一道 `!loaded` 注回后没有任何用例变红——测不出来的防护不留。）
   */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  /** 二次确认态（整表替换，@why 见文件头）。 */
  const [confirming, setConfirming] = useState(false);
  /** 整表替换请求在途（P2-47）：连点"确认"会把同一张表 PUT 两次，第二次可能覆盖别人刚做的改动。 */
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const raw = await listShippingRates(api);
      setRows(
        raw.map((r) => ({
          carrier: r.carrier ?? '',
          maxWeightG: Number.isInteger(r.max_weight_g) ? String(r.max_weight_g) : '',
          priceJpy: Number.isInteger(r.price_jpy) ? String(r.price_jpy) : '',
          active: r.active !== false,
        })),
      );
      setLoaded(true);
    } catch (e) {
      // ⚠️ 失败**不清空表格**：把已加载的档位清掉会让"改了一半的表"丢失
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = rateErrors(rows);
  // 按**表格行的原顺序**给出"是否重复"（不能拿排过序的视图按下标对，AJ-232）
  const duplicates = rateDuplicates(rows);

  const save = async (): Promise<void> => {
    if (saving) return;
    if (!check.ok) {
      setError(check.first);
      return;
    }
    setError('');
    setOk('');
    setSaving(true);
    try {
      await replaceShippingRates(api, toRateBody(rows));
      setOk('已整表替换（下一次报价立即按新档位计算）');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="title">运费分档</h2>
        {loading && <span className="muted">加载中…</span>}
      </header>

      {/* 三端联动模拟 2026-10-08：原先把 Markdown（反引号、双星号）原样显示在页面上 */}
      <p className="muted">
        「重量上限」含本数：包裹重量取第一个 ≥ 它的档（向上取档，D-46）。保存是
        <strong>整表替换</strong>
        ——表里删掉的档会从线上消失。
      </p>

      <table className="table">
        <thead>
          <tr>
            <th>承运商</th>
            <th>重量上限（g）</th>
            <th>运费（円）</th>
            <th>启用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  className="input"
                  value={r.carrier}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (i === j ? { ...x, carrier: e.target.value } : x)),
                    )
                  }
                />
              </td>
              <td>
                <input
                  className="input"
                  value={r.maxWeightG}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (i === j ? { ...x, maxWeightG: e.target.value } : x)),
                    )
                  }
                />
              </td>
              <td>
                <input
                  className="input"
                  value={r.priceJpy}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (i === j ? { ...x, priceJpy: e.target.value } : x)),
                    )
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={r.active}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (i === j ? { ...x, active: e.target.checked } : x)),
                    )
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  删除
                </button>
                {duplicates[i] === true && <span className="error">档位重复</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && loaded && (
            <tr>
              <td className="muted" colSpan={5}>
                还没有运费档位（所有订单都无法报价）
              </td>
            </tr>
          )}
          {!loaded && !loading && (
            <tr>
              <td className="error" colSpan={5}>
                运费档位没有加载出来，暂时不能编辑（现在保存会用空表替换线上的整张运费表）。
                <button type="button" className="link" onClick={() => void load()}>
                  重新加载
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="row2">
        <button
          type="button"
          className="btn"
          disabled={!loaded}
          onClick={() => setRows((prev) => [...prev, emptyRateRow(prev[0]?.carrier ?? '')])}
        >
          新增一档
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : `确认：用当前 ${rows.length} 档替换全部`}
            </button>
            <button
              type="button"
              className="link"
              disabled={saving}
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={!check.ok}
            onClick={() => setConfirming(true)}
          >
            保存（整表替换）
          </button>
        )}
      </div>

      {!check.ok && (
        <div className="field">
          {check.errors.map((e) => (
            <span className="error" key={e}>
              {e}
            </span>
          ))}
        </div>
      )}
      {error !== '' && <p className="error">{error}</p>}
      {ok !== '' && <p className="ok">{ok}</p>}
    </section>
  );
}
