/**
 * 职责：订单列表页（状态页签 / 下单日期 / 关键词搜索 / 分页 / 去详情）。
 *
 * @why **筛选条件变了要回到第 1 页**：不回的话会出现"筛选后停在第 3 页、
 *      结果只有 2 条但页面显示空白"，运营会以为订单消失了。
 *
 * @limitation 一：列表接口返回 `AdminOrderListItem`（契约 0.6.1），**带** `has_dispute`，
 *              所以"拒付中"在列表页就能显示徽标（0.6.1 之前列表没有这个字段，
 *              只能"看到标记才显示"——那条兜底现在仍在：不因为"没查到"就声称没有拒付）。
 *              ⚠️ 徽标的真值以**详情**为准：列表是缓存的一次快照，详情页会重新拉单条。
 * @limitation 二：详情是**整块替换列表**（不是弹层）：详情要展示商品行、地址、支付、
 *              事件时间线，弹层放不下；代价是返回时要重新拉一次列表（见 @why 刷新）。
 * @limitation 三：关键词搜索是**显式点搜索**（不是边打边搜）——
 *              每敲一个字发一次请求会让分页与结果在输入过程中反复抖动，
 *              而运营搜单号通常是整段粘贴。
 * @limitation 四（第一批②）：**筛选条件与当前打开的订单都以 URL 为唯一真源**
 *              （`status` / `q` / `test` / `page` / `range` / `from` / `to` 查询参数 + 路径上的订单 id）。
 *              AJ-400：`status` 可逗号分隔（页签 = 几个状态），日期存预设名（`range=7d`），自定义才存 `from` / `to`。
 *              @why 不做"组件 state 与 URL 双向同步"：那需要两边互相写，
 *                   而"改筛选 → 写 URL → 触发 hashchange → 又写回 state"这类环
 *                   一旦有一处比较不严就是抖动或死循环。单向（URL → 组件）没有这个失效形态。
 *              @why 因此"筛好一个列表发给同事"是**字面意义上**的一个链接：
 *                   `#/orders?status=paid` 打开即待发货列表，刷新、后退、收藏都一样。
 *              @limitation 默认值（`all` / 第 1 页 / 不含测试单）**不写进 URL**：
 *                         写了会让地址栏拖一串没有信息的 `?status=all&page=1&test=0`。
 *
 * @limitation 五（AJ-401 / AJ-407）：**所有页签**都有行勾选（AJ-407 起；此前只在「待发货」），勾选后出现
 *              「导出所选」与「打印拣货单与面单信息」（SelectionBar）；「批量发货」与「导入运单号（CSV）」仍只在「待发货」页签，
 *              且该页签下拒付 / 测试单不能勾（与详情页发货闸门同口径）。
 *              勾选只在当前页内，列表一重载（翻页 / 刷新 / 发货后）勾选即清空——勾选不进 URL（它不是筛选条件）。
 *              打印页同样不进 URL（刷新回列表）：它依赖勾选，而勾选本就不进 URL。
 *
 * @see ./view.ts（行视图与闸门）；./api.ts（接口层）；./OrderDetail.tsx；../router.ts
 */
import { ExportBar } from './ExportBar.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SEARCH_KEYWORD_MAX_LENGTH, type OrderStatus } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { listOrders, type AdminApi, type AdminOrderLike } from './api.js';
import { ORDER_STATUS_LABELS, orderRows, shipGate, type OrderRow } from './view.js';
import { ShipBatchDrawer } from './ShipBatchDrawer.js';
import { CsvShipImport } from './CsvShipImport.js';
import { SelectionBar } from './SelectionBar.js';
import { PrintSheet } from './PrintSheet.js';
import { ToastStack, useToasts } from '../ui/toast.js';
import { readStatusFilter, resolveDateRange, STATUS_TABS, tabStatusParam } from './list-filter.js';
import { RowShipDrawer } from './RowShipDrawer.js';
import { StatusTabs } from './StatusTabs.js';
import { DateFilter } from './DateFilter.js';
import { Badge } from '../ui/badge.js';
import { flagBadges, statusBadge } from './badges.js';
import { OrderDetail } from './OrderDetail.js';
import type { Route } from '../router.js';

/** 每页条数（契约默认 20；与商品管理同口径，一屏放得下）。 */
const PAGE_SIZE = 20;

/** 四个查询参数的键（改这里要同步改 @limitation 四 与 router 的用法说明）。 */
const Q = {
  status: 'status',
  q: 'q',
  test: 'test',
  page: 'page',
  range: 'range',
  from: 'from',
  to: 'to',
} as const;

export interface OrdersPageProps {
  api: AdminApi;
  /** 当前路由（筛选真源，@see @limitation 四）。 */
  route: Route;
  /** 换页 / 改筛选 / 开详情：由外层执行真正的地址栏写入。 */
  onNavigate: (next: Route) => void;
}

export function OrdersPage({ api, route, onNavigate }: OrdersPageProps) {
  /**
   * 改查询参数（**不改路径上的订单 id**，那是另一件事）。
   * @why 值等于默认值的键直接删掉而不是写 `status=all`：地址栏是给人看和复制的，
   *      多余的参数会让人以为"我筛过了"，也会让两个实际相同的列表看起来是两个地址。
   */
  const patch = useCallback(
    (next: Partial<Record<(typeof Q)[keyof typeof Q], string>>): void => {
      const query = new URLSearchParams(route.query);
      for (const [key, value] of Object.entries(next)) {
        const drop =
          value === undefined ||
          value === '' ||
          (key === Q.status && value === 'all') || // 旧收藏里的 `status=all` 也当默认
          (key === Q.page && value === '1') ||
          (key === Q.test && value === '0');
        if (drop) query.delete(key);
        else query.set(key, value);
      }
      onNavigate({ page: 'orders', id: '', query });
    },
    // ⚠️ `patch` 进了 `load` 的依赖数组：它必须是稳定的，否则每次渲染都会重新拉列表（乃至死循环）。
    //    `route.query` 在同一个路由下是同一个实例（外层只在 hashchange 时换 route），`onNavigate` 由外层 useCallback 固定。
    [route.query, onNavigate],
  );

  // ── 以下全部由 URL 派生（@see @limitation 四）────────────────────
  // 认不出的 `?status=`（手改地址、旧收藏）回落为「全部」（AJ-398）：原样发给服务端会得到 40001，
  // 页面一片空白、看不出是筛选坏了。页签与 URL 的对应见 list-filter.ts。
  const { statuses, tabKey, narrowed } = readStatusFilter(route.query.get(Q.status));
  /** 进 load 依赖的是字符串：`statuses` 每次渲染都是新数组，直接放进依赖会每次渲染都重拉列表。 */
  const statusKey = statuses.join(',');
  const dateValue = {
    range: route.query.get(Q.range) ?? '',
    from: route.query.get(Q.from) ?? '',
    to: route.query.get(Q.to) ?? '',
  };
  // 日界按 JST（list-filter @limitation 一）；自定义有误 → 提示、不发请求
  const dates = resolveDateRange(dateValue.range, dateValue.from, dateValue.to, new Date());
  const dateError = dates.error ?? '';
  const createdFrom = dates.createdFrom;
  const createdTo = dates.createdTo;
  const applied = route.query.get(Q.q) ?? '';
  const includeTest = route.query.get(Q.test) === '1';
  const page = Math.max(1, Number(route.query.get(Q.page) ?? '1') || 1);
  const [rows, setRows] = useState<OrderRow[]>([]);
  /** 服务端原始条目：详情页要先拿到 has_dispute 才知道能不能退款（@see @limitation 一）。 */
  const [raw, setRaw] = useState<AdminOrderLike[]>([]);
  const [total, setTotal] = useState(0);
  /** 输入框里的值（未提交）；提交后写进 URL 的 `q`（@limitation 四）。 */
  const [keyword, setKeyword] = useState(applied);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 「待发货」页签下勾选的订单 id（AJ-401；列表重载即清空，@limitation 五）。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<'select' | 'csv' | null>(null);
  const batchMode = tabKey === 'to_ship';
  /** 行内「发货」打开的订单 id（AJ-410 / N12）；null = 没开。 */
  const [shipId, setShipId] = useState<string | null>(null);
  const shipOrderRow = shipId === null ? undefined : raw.find((o) => o.order_id === shipId);
  /** 打印页（AJ-407）：点击时冻结的所选 id；null = 看列表。 */
  const [printIds, setPrintIds] = useState<string[] | null>(null);
  /** 批量发货的整次失败走 Toast（ui/adoption 门禁：新页面不写行内反馈）。 */
  const sink = useToasts();
  const batchError = (text: string, traceId: string | undefined): void =>
    sink.error(text, { traceId });
  /** 当前打开的订单 id（null = 看列表）——来自路径，不是本地 state。 */
  const detailId = route.id === '' ? null : route.id;

  // URL 上的 `q` 变了（前进 / 后退 / 从工作台跳进来）→ 输入框跟着变，
  // 否则会出现"列表是按 abc 筛的，搜索框里却还写着 xyz"。
  useEffect(() => {
    setKeyword(applied);
  }, [applied]);
  /**
   * 手动刷新的自增计数（ADM3-09）。
   * @why 列表只随 `page / status / applied` 变化而重载，而这三项在"用同一个关键词再点一次搜索"
   *      时**一项都不变** → effect 不触发 → 列表不动。客服此时的场景正是"客户说刚付了款，
   *      我再点一次搜索看看"，而页面纹丝不动会让他据此回复"还没收到款"。
   *      唯一能刷新它的旁路是切页签再切回来，或进一趟详情——都是绕路。
   *      @tradeoff 用计数而不是把 `load` 从 deps 里拿出来手动调：后者要人记住"哪些地方改了依赖还得手动补一次"，
   *              计数只要加进 deps 就永远有效。
   */
  const [reloadTick, setReloadTick] = useState(0);
  /** 提交搜索（按钮与回车共用）。 */
  const search = (): void => {
    const next = keyword.trim();
    // ⚠️ 关键词没变也要重载（ADM3-09）：只改 URL 的话，值没变 → load 的依赖不变 → 不请求。
    //    运营点"搜索"的意图里本来就包含"再查一次"，不该被 react 的依赖比较吞掉。
    if (next === applied) setReloadTick((t) => t + 1);
    else patch({ q: next, page: '1' }); // 同时回第 1 页（@why 文件头第一段）
  };

  /** 请求序号（A-05）：晚到的旧响应不得覆盖新列表，只有最后一次发起的请求能写。 */
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    if (dateError !== '') return; // 自定义日期有误：保留上一次的列表，等运营改对
    const seq = ++reqSeq.current;
    setLoading(true);
    setError('');
    try {
      const res = await listOrders(api, {
        page,
        size: PAGE_SIZE,
        keyword: applied,
        ...(statusKey === '' ? {} : { status: statusKey.split(',') as OrderStatus[] }),
        ...(createdFrom !== undefined ? { createdFrom } : {}),
        ...(createdTo !== undefined ? { createdTo } : {}),
        includeTest,
      });
      if (seq !== reqSeq.current) return;
      setRaw(res.items);
      setSelected(new Set());
      setRows(orderRows(res.items));
      setTotal(res.total);
      // 扫描 A-02：当前页超出最后一页（例如最后一页唯一一张单刚发货）→ 拉回最后一页，不停在"空页"
      const last = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
      if (page > last) patch({ page: String(last) });
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // ⚠️ 失败不清列表（同商品管理）：只显示错误，列表保留上一次结果
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [
    api,
    page,
    statusKey,
    applied,
    reloadTick,
    includeTest,
    patch,
    createdFrom,
    createdTo,
    dateError,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  /** 能勾的单：「待发货」页签与详情页发货按钮同一个闸门（拒付 / 测试单不能勾）；其它页签全部可勾（只用于导出 / 打印）。 */
  const selectable = (batchMode ? raw.filter((o) => shipGate(o).ok) : raw).map((o) => o.order_id);
  /** 按列表顺序的所选 id（导出 / 打印按这个顺序）。 */
  const selectedIds = rows.map((r) => r.id).filter((id) => selected.has(id));
  const selectedPaid = raw.filter((o) => selected.has(o.order_id) && o.status === 'paid').length;

  if (printIds !== null) {
    return (
      <PrintSheet api={api} ids={printIds} onBack={() => setPrintIds(null)} onError={batchError} />
    );
  }

  if (detailId !== null) {
    return (
      <OrderDetail
        api={api}
        id={detailId}
        source={raw.find((o) => o.order_id === detailId) ?? null}
        onBack={() => onNavigate({ page: 'orders', id: '', query: route.query })}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">订单管理</h1>
        <span className="muted">时间均为日本时间</span>
      </header>

      {/* 状态页签 + 计数（AJ-400）：取代原来的状态下拉与页内待办条（工作台仍保留待办条） */}
      <StatusTabs
        api={api}
        current={tabKey}
        base={{
          keyword: applied,
          includeTest,
          ...(createdFrom !== undefined ? { createdFrom } : {}),
          ...(createdTo !== undefined ? { createdTo } : {}),
        }}
        refreshKey={reloadTick}
        onPick={(t) => patch({ status: tabStatusParam(t), page: '1' })}
      />
      {narrowed && tabKey !== null && (
        // AJ-410 / N27：单状态链接（工作台待办、`status=shipped`）高亮所属页签，并说清只显示其中一部分
        <p className="muted">
          此页签下只显示：{statuses.map((s) => ORDER_STATUS_LABELS[s]).join('、')}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              const t = STATUS_TABS.find((x) => x.key === tabKey);
              if (t !== undefined) patch({ status: tabStatusParam(t), page: '1' });
            }}
          >
            显示本页签全部
          </button>
        </p>
      )}
      {tabKey === null && (
        // 跨页签的自定义状态集合：明说当前筛的是什么
        <p className="muted">
          当前筛选：{statuses.map((s) => ORDER_STATUS_LABELS[s]).join('、')}{' '}
          <button type="button" className="link" onClick={() => patch({ status: '', page: '1' })}>
            清除
          </button>
        </p>
      )}

      {/* 剩余清单 3-3：CSV 导出（订单总表 / 待采购 / 报关） */}
      <ExportBar api={api} />

      <DateFilter
        value={dateValue}
        error={dateError}
        onChange={(v) => patch({ range: v.range, from: v.from, to: v.to, page: '1' })}
      />

      <div className="filters">
        <label className="muted">
          <input
            type="checkbox"
            aria-label="显示测试订单"
            checked={includeTest}
            onChange={(e) => patch({ test: e.target.checked ? '1' : '0', page: '1' })}
          />
          显示测试订单
        </label>
        <input
          className="input"
          placeholder="单号 / 收件人 / 运单号"
          // 与服务端同一个上限（shared）：超长关键词服务端会 40001，前端直接不让输（P2-47）
          maxLength={SEARCH_KEYWORD_MAX_LENGTH}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          // 回车即搜索（三端联动模拟 2026-10-08：输入单号后按回车没反应，运营以为搜不到）。
          // ⚠️ 输入法合成中的回车是在选字，不是提交（与商品标签框 A-09 同口径）
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) search();
          }}
        />
        <button type="button" className="btn btn-secondary" onClick={search}>
          搜索
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setReloadTick((t) => t + 1)}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error !== '' && <p className="error">{error}</p>}
      {loading && <p className="muted">加载中…</p>}
      {!loading && rows.length === 0 && error === '' && <p className="muted">没有符合条件的订单</p>}

      {batchMode && (
        // AJ-401：批量发货 / CSV 导入（抽屉）
        <div className="filters">
          <button
            type="button"
            className="btn"
            disabled={selected.size === 0}
            // N11：灰着的按钮要说清怎么让它能点
            title={selected.size === 0 ? '先勾选左边方框，选中要发货的订单' : undefined}
            onClick={() => setBatch('select')}
          >
            批量发货（{selected.size}）
          </button>
          {selected.size === 0 && <span className="muted">先勾选左边方框</span>}
          <button type="button" className="btn btn-secondary" onClick={() => setBatch('csv')}>
            导入运单号（Excel/表格文件）
          </button>
          <span className="muted">一次填好多单的运单号：把表格另存为 CSV 后导入</span>
        </div>
      )}
      <SelectionBar
        api={api}
        ids={selectedIds}
        paidCount={selectedPaid}
        onPrint={() => setPrintIds(selectedIds)}
        onInfo={(text) => sink.info(text)}
        onError={batchError}
      />
      {batch === 'select' && (
        <ShipBatchDrawer
          api={api}
          orders={raw.filter((o) => selected.has(o.order_id))}
          onClose={() => setBatch(null)}
          onDone={() => setReloadTick((t) => t + 1)}
          onError={batchError}
        />
      )}
      {batch === 'csv' && (
        <CsvShipImport
          api={api}
          onClose={() => setBatch(null)}
          onDone={() => setReloadTick((t) => t + 1)}
          onError={batchError}
        />
      )}
      {shipId !== null && shipOrderRow !== undefined && (
        <RowShipDrawer
          api={api}
          order={shipOrderRow}
          sink={sink}
          onClose={() => setShipId(null)}
          onShipped={() => setReloadTick((t) => t + 1)}
        />
      )}
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />

      <table className="table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label={batchMode ? '全选本页可发货订单' : '全选本页订单'}
                checked={selectable.length > 0 && selectable.every((id) => selected.has(id))}
                onChange={(e) => setSelected(new Set(e.target.checked ? selectable : []))}
              />
            </th>
            <th>订单号</th>
            <th>状态</th>
            {/* 待采购清单的本体（§2.7：清单 = 本页筛 status=paid） */}
            <th>采购信息</th>
            <th>金额</th>
            <th>下单时间</th>
            <th>收件人</th>
            <th>物流</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`选择 ${row.orderNo}`}
                  disabled={!selectable.includes(row.id)}
                  checked={selected.has(row.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(row.id);
                    else next.delete(row.id);
                    setSelected(next);
                  }}
                />
              </td>
              <td className="mono">{row.orderNo}</td>
              <td>
                {/* AJ-400：彩色徽章（statusText 文案不变，色调见 badges.ts） */}
                {[
                  statusBadge(raw.find((o) => o.order_id === row.id) ?? { status: '' }),
                  ...flagBadges({ has_dispute: row.hasDispute, is_test: row.isTest }),
                ].map((b) => (
                  <Badge key={b.text} tone={b.tone}>
                    {b.text}
                  </Badge>
                ))}
              </td>
              <td className="purchase-cell" title={row.purchaseLines.join('\n')}>
                {row.purchaseLines.length === 0 ? (
                  '—'
                ) : (
                  <>
                    {row.purchaseLines.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </>
                )}
              </td>
              <td className="cell-nowrap">{row.totalText}</td>
              <td className="muted cell-nowrap">{row.createdText}</td>
              <td>{row.recipientText}</td>
              {/* 承运商与运单号各占一行、不折行：原先 "Japan Post EMS / EM…JP 查件" 被挤成 4 行（2026-10-09 验收） */}
              <td className="muted ship-cell">
                {row.shipText === ''
                  ? '—'
                  : row.shipText.split(' / ').map((part, i) => (
                      <div key={i} className={i === 1 ? 'mono' : undefined}>
                        {part}
                        {i === row.shipText.split(' / ').length - 1 && row.trackingUrl !== '' && (
                          <>
                            {' '}
                            <a href={row.trackingUrl} target="_blank" rel="noreferrer">
                              查件
                            </a>
                          </>
                        )}
                      </div>
                    ))}
              </td>
              <td>
                {/* N12：待发货页签每行直接发货（同一张发货表单 ShipForm，闸门与校验不另写） */}
                {batchMode && row.actions.ship.ok && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setShipId(row.id)}
                  >
                    发货
                  </button>
                )}{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onNavigate({ page: 'orders', id: row.id, query: route.query })}
                >
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="pager">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page <= 1}
          onClick={() => patch({ page: String(Math.max(1, page - 1)) })}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {lastPage} 页 · 共 {total} 单
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page >= lastPage}
          onClick={() => patch({ page: String(page + 1) })}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
