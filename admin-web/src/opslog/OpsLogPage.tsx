/**
 * 职责：运营日志页（剩余清单 3-2）——上半部分"最近一次自动核对（订单与支付记录）"，下半部分管理员操作审计（可按操作人 / 对象过滤、翻页）。
 *
 * @why 两件事放一页：都是"出事之后来查"的，运营要回答的问题是"昨晚对账有没有异常、谁动过这张单"。
 * @why 请求序号（同 RiskPage A-05）：快速翻页 / 改过滤时，晚到的旧响应不得覆盖新列表。
 * @limitation 只读；对账里的取样 id 不做跳转（订单页按单号搜即可）。
 * @limitation 两处加载失败（核对结果 / 操作记录）走同一个 `ui/Toast`（审查 2026-10-09，ui/adoption 欠账清单）。
 *      @tradeoff 同一 kind 只留最新一条：两处同时失败只看得到后到的那条（多半同一原因：断网 / 登录失效），
 *                翻页 / 查询会先清掉旧错误——放弃的是"核对结果的加载失败一直挂着"，换来的是重试成功后不残留旧红字。
 * @see ./view.ts；./api.ts
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCategories } from '../categories/useCategories.js';
import { parseJstDateRange } from '@waselect/shared';
import { Badge } from '../ui/badge.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
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

/** 谁处理 → 徽标文案与色调（运营 = 要动手，技术人员 = 转交，留意 = 多为正常现象）。 */
const OWNER_TEXT = { ops: '运营', tech: '技术人员', watch: '留意即可' } as const;
const OWNER_TONE = { ops: 'warn', tech: 'info', watch: 'muted' } as const;

export function OpsLogPage({ api }: OpsLogPageProps) {
  const [recon, setRecon] = useState<ReconciliationView | null>(null);
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState('');
  /** 操作日期范围（评估 P2，2026-10-09）：日本时间日历日、两端都含当天，口径同订单列表的下单日期。 */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** 已提交的过滤条件（输入框改了不立刻查，点"查询"才生效）。 */
  const [filter, setFilter] = useState({ actor: '', target: '', from: '', to: '' });
  /** 本页反馈出口（原两行红字：核对结果加载失败 / 操作记录加载失败）。 */
  const sink = useToasts();
  const seq = useRef(0);
  /** 分类键 → 名称（对象列写分类名，全入口点击测试 2026-10-12）。 */
  const { list: categories } = useCategories(api);
  const categoryNames = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.key, c.name])),
    [categories],
  );

  useEffect(() => {
    latestReconciliation(api)
      .then((run) => setRecon(reconciliationView(run)))
      .catch((e: unknown) => {
        const { text, traceId } = toastError(e, '核对结果加载失败');
        sink.error(text, { traceId });
      });
  }, [api, sink.error]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    sink.error('');
    try {
      const r = await listAudit(api, { page, ...filter });
      if (mine !== seq.current) return;
      setRows(auditRows(r.items, { categoryNames }));
      setTotal(r.total);
    } catch (e) {
      if (mine === seq.current) {
        const { text, traceId } = toastError(e, '操作记录加载失败');
        sink.error(text, { traceId });
      }
    }
  }, [api, page, filter, sink.error, categoryNames]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    // 与其它页同一套卡片样式（三端联动 UI 模拟 2026-10-08：原先没有 panel，标题直接压在背景上）
    <section className="panel">
      <h2 className="title">最近一次自动核对（订单与支付记录）</h2>
      {recon !== null && (
        <div className="form">
          <span className={recon.ok ? 'ok' : 'error'}>{recon.headline}</span>
          {recon.summary !== '' && <span className="muted">{recon.summary}</span>}
          {/* 三端模拟测试 2026-10-11（用户截图）：原先每类后面铺一墙订单链接——改成异常看板：
              一类一行，说清怎么处理、谁处理，能筛的给「去处理」；示例最多 3 个（排查用） */}
          {recon.rows.length > 0 && (
            <table className="table recon-table">
              <thead>
                <tr>
                  <th>异常</th>
                  <th>数量</th>
                  <th>怎么处理</th>
                  <th>谁处理</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {recon.rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="cell-nowrap">{r.count}</td>
                    <td>
                      {r.advice}
                      {r.samples.length > 0 && (
                        <span className="muted recon-samples">
                          示例：
                          {r.samples.map((s, i) => (
                            <span key={`${s.label}-${String(i)}`}>
                              {i > 0 && '、'}
                              {s.href === '' ? (
                                <span className="mono">{s.label}</span>
                              ) : (
                                <a className="link mono" href={s.href}>
                                  {s.label}
                                </a>
                              )}
                            </span>
                          ))}
                          {r.more > 0 && ` 等，共 ${String(r.count)} 条`}
                        </span>
                      )}
                    </td>
                    <td className="cell-nowrap">
                      <Badge tone={OWNER_TONE[r.owner]}>{OWNER_TEXT[r.owner]}</Badge>
                    </td>
                    <td className="cell-nowrap">
                      {r.href !== '' && (
                        <a className="link" href={r.href}>
                          去处理 →
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
          aria-label="对象"
          // 两端输入测试 2026-10-12：原写"对象 id"——内部 id 在界面上看不到；服务端现认这三种（内部 id 照旧可用）
          placeholder="对象：订单号 / 商品名 / 账号邮箱"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <label className="field-inline">
          <span className="muted">从</span>
          <input
            className="input"
            type="date"
            aria-label="开始日期（日本时间）"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field-inline">
          <span className="muted">到</span>
          <input
            className="input"
            type="date"
            aria-label="结束日期（日本时间）"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            // 先在本地把明显的错挡掉（说中文、不发请求）；最终仍以服务端 40001 为准
            const range = parseJstDateRange(from || undefined, to || undefined);
            if (!range.ok) {
              sink.error(
                range.reason === 'created_range_invalid'
                  ? '开始日期不能晚于结束日期'
                  : '日期格式不对，请用日期选择器重新选',
              );
              return;
            }
            setPage(1);
            setFilter({ actor, target, from, to });
          }}
        >
          查询
        </button>
      </div>
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
                {/* 三端模拟测试 2026-10-11（用户要求）：接口路径运营读不懂，挪进悬停（查日志 / 对代码时仍看得到） */}
                <span title={r.action !== r.actionRaw ? r.actionRaw : undefined}>{r.action}</span>
              </td>
              <td>
                {r.targetHref === '' ? (
                  <span title={r.targetTitle}>{r.targetText}</span>
                ) : (
                  <a className="link mono" href={r.targetHref} title={r.targetTitle}>
                    {r.targetText}
                  </a>
                )}
              </td>
              <td className={r.failed ? 'error' : 'muted'} title={r.statusTitle || undefined}>
                {r.statusText}
              </td>
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
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
    </section>
  );
}
