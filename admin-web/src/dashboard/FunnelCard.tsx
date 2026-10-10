/**
 * 职责：工作台「转化漏斗」卡片（第 25 项，AJ-438）——近 1 / 7 / 30 天，买家从进店到付款每一步还剩多少人。
 *
 * @why 放在工作台而不是单独一页：运营每天第一眼看工作台，"今天卡在哪一步"和"今天卖了多少"应该在一处。
 * @why 档位用 chip 而不是日期选择器：与订单页"今天 / 近 7 天 / 近 30 天"同一组档位；服务端也只收这三档。
 * @why 失败只在卡片里说"取不到"并给「重试」，不弹全局错误：漏斗是参考数据，取不到不该挡住待办与销售。
 * @limitation 只读：没有点进"这一步的人是谁"的明细（隐私上也不该轻易给到个人）；口径说明在卡片底部一行小字。
 * @see ./funnel-view.ts（展示口径）；../../../server/src/adapters/funnel.ts（统计口径）
 */
import { useCallback, useEffect, useState } from 'react';
import { getFunnel, type AdminApi } from './api.js';
import { funnelRows, type FunnelRow } from './funnel-view.js';

const RANGES = [
  { days: 1, label: '今天' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
] as const;
type Days = (typeof RANGES)[number]['days'];

export function FunnelCard({ api }: { api: AdminApi }) {
  const [days, setDays] = useState<Days>(7);
  const [rows, setRows] = useState<FunnelRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [seq, setSeq] = useState(0);

  const retry = useCallback(() => setSeq((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    getFunnel(api, days)
      .then((r) => {
        if (alive) setRows(funnelRows(r.steps));
      })
      .catch(() => {
        if (!alive) return;
        setRows(null);
        setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [api, days, seq]);

  return (
    <section className="panel" aria-label="转化漏斗">
      <h2 className="title">转化漏斗</h2>
      <p className="muted">买家从进店到付款，每一步还剩多少人——看客人卡在哪一步。</p>
      <div className="chips">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            className={r.days === days ? 'chip chip-on' : 'chip'}
            onClick={() => setDays(r.days)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {failed ? (
        <p className="muted">
          漏斗数据暂时取不到。
          <button type="button" className="link" onClick={retry}>
            重试
          </button>
        </p>
      ) : rows === null ? (
        <p className="muted">加载中…</p>
      ) : (
        <ol className="funnel">
          {rows.map((r) => (
            <li key={r.key} className="funnel-row">
              <span className="funnel-label">{r.label}</span>
              <span className="funnel-track">
                <span className="funnel-bar" style={{ width: `${String(r.widthPct)}%` }} />
              </span>
              <span className="funnel-count">{r.visitors} 人</span>
              <span className="funnel-rate muted">{r.rateText}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="stat-hint">
        按人去重，每一步只数上一步也到过的人；"付款成功"以订单实际到账为准，不含测试单。
      </p>
    </section>
  );
}
