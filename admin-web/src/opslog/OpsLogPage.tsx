/**
 * 职责：运营日志页（剩余清单 3-2）——上半部分"最近一次自动核对（订单与支付记录）"，下半部分管理员操作审计（可按操作人 / 对象过滤、翻页）。
 *
 * @why 两件事放一页：都是"出事之后来查"的，运营要回答的问题是"昨晚对账有没有异常、谁动过这张单"。
 * @why 请求序号（同 RiskPage A-05）：快速翻页 / 改过滤时，晚到的旧响应不得覆盖新列表。
 * @limitation 只读；对账里的取样 id 不做跳转（订单页按单号搜即可）。
 * @see ./view.ts；./api.ts
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { AUDIT_PAGE_SIZE, latestReconciliation, listAudit, type AdminApi } from './api.js';
import {
  auditRows,
  reconciliationView,
  type AuditRowView,
  type ReconciliationView,
} from './view.js';

export interface OpsLogPageProps {
  api: AdminApi;
}

const errText = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

export function OpsLogPage({ api }: OpsLogPageProps) {
  const [recon, setRecon] = useState<ReconciliationView | null>(null);
  const [reconError, setReconError] = useState('');
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState('');
  /** 已提交的过滤条件（输入框改了不立刻查，点"查询"才生效）。 */
  const [filter, setFilter] = useState({ actor: '', target: '' });
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    latestReconciliation(api)
      .then((run) => setRecon(reconciliationView(run)))
      .catch((e: unknown) => setReconError(errText(e)));
  }, [api]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError('');
    try {
      const r = await listAudit(api, { page, ...filter });
      if (mine !== seq.current) return;
      setRows(auditRows(r.items));
      setTotal(r.total);
    } catch (e) {
      if (mine === seq.current) setError(errText(e));
    }
  }, [api, page, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    // 与其它页同一套卡片样式（三端联动 UI 模拟 2026-10-08：原先没有 panel，标题直接压在背景上）
    <section className="panel">
      <h2 className="title">最近一次自动核对（订单与支付记录）</h2>
      {reconError !== '' && <p className="error">{reconError}</p>}
      {recon !== null && (
        <div className="form">
          <span className={recon.ok ? 'ok' : 'error'}>{recon.headline}</span>
          {recon.lines.map((l) => (
            <span key={l} className="muted">
              {l}
            </span>
          ))}
        </div>
      )}

      <h2 className="title">管理员操作记录</h2>
      <div className="filters">
        <input
          className="input"
          aria-label="操作人"
          placeholder="操作人邮箱（或 admin:内部 id）"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <input
          className="input"
          aria-label="对象 id"
          placeholder="对象 id（订单 / 商品）"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPage(1);
            setFilter({ actor, target });
          }}
        >
          查询
        </button>
      </div>
      {error !== '' && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>时间（日本时间）</th>
            <th>操作人</th>
            <th>操作</th>
            <th>对象</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="muted">{r.timeText}</td>
              <td>{r.actor}</td>
              <td>
                {r.action}
                {r.action !== r.actionRaw && <span className="muted"> · {r.actionRaw}</span>}
              </td>
              <td>{r.targetText}</td>
              <td className={r.failed ? 'error' : 'muted'}>{r.statusText}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="muted" colSpan={5}>
                没有记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row2">
        <button
          type="button"
          className="link"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {pages} 页，共 {total} 条
        </span>
        <button
          type="button"
          className="link"
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
