/**
 * 职责：运营日志页（剩余清单 3-2）——上半部分"最近一次自动核对（订单与支付记录）"，下半部分管理员操作审计（可按操作人 / 对象过滤、翻页）。
 *
 * @why 两件事放一页：都是"出事之后来查"的，运营要回答的问题是"昨晚对账有没有异常、谁动过这张单"。
 * @why 请求序号（同 RiskPage A-05）：快速翻页 / 改过滤时，晚到的旧响应不得覆盖新列表。
 * @limitation 只读；对账里的取样 id 不做跳转（订单页按单号搜即可）。
 * @limitation 两处加载失败（核对结果 / 操作记录）走同一个 `ui/Toast`（审查 2026-10-09，ui/adoption 欠账清单）。
 *      @tradeoff 同一 kind 只留最新一条：两处同时失败只看得到后到的那条（多半同一原因：断网 / 登录失效），
 *                翻页 / 查询会先清掉旧错误——放弃的是"核对结果的加载失败一直挂着"，换来的是重试成功后不残留旧红字。
 *      ⚠️ 只走 Toast 不够（体验审查 2026-10-15，P2-4）：失败时列表**保留上一次结果**，
 *         右下角的 Toast 与表格没有视觉关联，所以表格上方另给一行页内标记 `<ListError>`。
 * @limitation 页码 / 每页条数 / 过滤条件都在**地址栏**（体验审查 2026-10-15，P2-5）：
 *              原先只有 `page` 是本地 state —— 刷新、分享、后退全部回第 1 页，与本项目
 *              "列表状态走 URL"的约定（@see ../orders/OrdersPage.tsx @limitation 四）不一致。
 *              输入框仍按"点了「查询」才生效"（过滤涉及日期范围，边打字边发请求会打出一串无效查询）。
 * @see ./view.ts；./api.ts
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCategories } from '../categories/useCategories.js';
import { parseJstDateRange, SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { Badge } from '../ui/badge.js';
import { ListError } from '../ui/list-error.js';
import { PageSizeSelect, PAGE_SIZE_OPTIONS } from '../ui/list-controls.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { AUDIT_PAGE_SIZE, latestReconciliation, listAudit, type AdminApi } from './api.js';
import {
  auditRows,
  reconciliationView,
  type AuditRowView,
  type ReconciliationView,
} from './view.js';
import type { Route } from '../router.js';

/** 地址栏参数名（本页只认这六个）。 */
const Q = {
  page: 'page',
  size: 'size',
  actor: 'actor',
  target: 'target',
  from: 'from',
  to: 'to',
} as const;

export interface OpsLogPageProps {
  api: AdminApi;
  /** 当前路由（页码 / 每页条数 / 过滤条件的真源，@see 文件头 @limitation）。 */
  route: Route;
  /** 翻页 / 改条数 / 查询：由外层执行真正的地址栏写入。 */
  onNavigate: (next: Route) => void;
}

/** 谁处理 → 徽标文案与色调（运营 = 要动手，技术人员 = 转交，留意 = 多为正常现象）。 */
const OWNER_TEXT = { ops: '运营', tech: '技术人员', watch: '留意即可' } as const;
const OWNER_TONE = { ops: 'warn', tech: 'info', watch: 'muted' } as const;

export function OpsLogPage({ api, route, onNavigate }: OpsLogPageProps) {
  const [recon, setRecon] = useState<ReconciliationView | null>(null);
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [total, setTotal] = useState(0);
  /**
   * 取数在途（体验审查 2026-10-15，P2-3）。
   * @why 原先这一页**完全没有** loading 态：点「下一页 / 查询」后有 0.3–2 秒页面纹丝不动
   *      （表格还留着上一次的内容、分页器还是旧的页码）⇒ 运营连点「下一页」，
   *      一次跳过多页（中途还会被 `seq` 竞态丢掉一次）。日志页是排查问题用的，误跳页等于漏看记录。
   */
  const [loading, setLoading] = useState(false);
  /** 列表取数失败（页内标记用；@see 文件头 @limitation）。 */
  const [failed, setFailed] = useState(false);
  // ── 以下由地址栏派生（P2-5）──────────────────────────────────
  const page = Math.max(1, Number(route.query.get(Q.page) ?? '1') || 1);
  const sizeRaw = Number(route.query.get(Q.size) ?? AUDIT_PAGE_SIZE);
  /** 认不出的值（手改地址、旧收藏）回落为默认——原样发给服务端会得到 40001，页面一片空白。 */
  const size = (PAGE_SIZE_OPTIONS as readonly number[]).includes(sizeRaw)
    ? sizeRaw
    : AUDIT_PAGE_SIZE;
  const actorQ = route.query.get(Q.actor) ?? '';
  const targetQ = route.query.get(Q.target) ?? '';
  const fromQ = route.query.get(Q.from) ?? '';
  const toQ = route.query.get(Q.to) ?? '';

  /** 改地址栏参数（值等于默认值的键直接删掉，地址是给人看和复制的）。 */
  const patch = useCallback(
    (next: Partial<Record<(typeof Q)[keyof typeof Q], string>>): void => {
      const query = new URLSearchParams(route.query);
      for (const [key, value] of Object.entries(next)) {
        const drop =
          value === undefined ||
          value === '' ||
          (key === Q.page && value === '1') ||
          (key === Q.size && value === String(AUDIT_PAGE_SIZE));
        if (drop) query.delete(key);
        else query.set(key, value);
      }
      onNavigate({ page: 'opslog', id: '', query });
    },
    [route.query, onNavigate],
  );

  /** 输入框里的值（未提交）；提交后写进地址栏，@see 下面的同步 effect。 */
  const [actor, setActor] = useState(actorQ);
  const [target, setTarget] = useState(targetQ);
  /** 操作日期范围（评估 P2，2026-10-09）：日本时间日历日、两端都含当天，口径同订单列表的下单日期。 */
  const [from, setFrom] = useState(fromQ);
  const [to, setTo] = useState(toQ);
  // 地址栏上的过滤条件变了（前进 / 后退 / 收藏打开）→ 输入框跟着变，
  // 否则会出现"列表是按 abc 筛的，搜索框里却还写着 xyz"（与订单页同一个口径）。
  // ⚠️ 依赖是四个**字符串**而不是 `route.query` 这个对象：翻页只改 `page`，
  //    这四个值不变 ⇒ effect 不跑 ⇒ 用户刚打了一半的过滤条件不会被翻页清掉。
  useEffect(() => {
    setActor(actorQ);
    setTarget(targetQ);
    setFrom(fromQ);
    setTo(toQ);
  }, [actorQ, targetQ, fromQ, toQ]);
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
    setLoading(true);
    setFailed(false);
    try {
      const r = await listAudit(api, {
        page,
        size,
        actor: actorQ,
        target: targetQ,
        from: fromQ,
        to: toQ,
      });
      if (mine !== seq.current) return;
      setRows(auditRows(r.items, { categoryNames }));
      setTotal(r.total);
    } catch (e) {
      if (mine !== seq.current) return;
      // 失败**不清列表**：已加载的记录还在（运营手上的上下文不能丢），
      // 但要给页内标记（P2-4）——否则他照着一份过期记录往下查。
      setFailed(true);
      const { text, traceId } = toastError(e, '操作记录加载失败');
      sink.error(text, { traceId });
    } finally {
      // ⚠️ 过期请求不动 loading：收尾归最新那一次（@why 否则先发的慢请求会把后发的"加载中"提前抹掉）
      if (mine === seq.current) setLoading(false);
    }
  }, [api, page, size, actorQ, targetQ, fromQ, toQ, sink.error, categoryNames]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / size));

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
                                <span className={s.plain === true ? undefined : 'mono'}>
                                  {s.label}
                                </span>
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
            // 过滤条件进地址栏（P2-5）：刷新 / 分享 / 后退都能回到这一屏
            patch({ actor, target, from, to, page: '1' });
          }}
        >
          查询
        </button>
      </div>
      {/* P2-3：请求期间页面必须自己说"在取"，否则运营会连点「下一页」跳过好几页 */}
      {loading && <p className="muted">加载中…</p>}
      {/* P2-4：失败时列表保留上一次结果，页内必须有一句"这不是最新的" */}
      {!loading && failed && <ListError what="操作记录" retry="查询" />}
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
      {/* 分页器与订单 / 商品 / 客户三页同一套（P2-5）：`footer.pager` + 次级按钮 + 每页条数。
          ⚠️ 在途时两个翻页按钮都禁用：连点会一次跳过多页（且中途那次会被 seq 判成过期响应丢掉）。 */}
      <footer className="pager">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page <= 1 || loading}
          onClick={() => patch({ [Q.page]: String(Math.max(1, page - 1)) })}
        >
          上一页
        </button>
        <span className="muted">{loading ? '' : `第 ${page} / ${pages} 页 · 共 ${total} 条`}</span>
        <PageSizeSelect
          size={size}
          onChange={(n) => patch({ [Q.size]: String(n), [Q.page]: '1' })}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page >= pages || loading}
          onClick={() => patch({ [Q.page]: String(page + 1) })}
        >
          下一页
        </button>
      </footer>
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
    </section>
  );
}
