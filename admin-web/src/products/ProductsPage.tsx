/**
 * 职责：商品列表页（分页 / 筛选 / 上下架 / 去编辑 / 内联改库存）。
 *
 * @why 草稿（AJ-403）与下架共用"上架"按钮：两者对买家都不可见，上架都走同一条 PATCH（同一组 40918 判定）。
 *
 * @why 上下架失败**保留列表**并只显示错误：清空列表的表现是"操作失败连商品都没了"，
 *      运营会以为数据丢了，而实际只是那一次 PATCH 没成功。
 *
 * @why 筛选 / 关键词 / 库存紧张 / 页码**进地址栏**（`#/products?status=offline&page=3`，与订单页、客户页同口径）：
 *      此前存在组件 state 里，改完第 8 页的一件商品回到列表就是第 1 页、筛选全丢；筛好的列表也不能发给同事、刷新即丢。
 *      （原 @limitation 一"不引入 react-router、后退键不该回到上一个 URL"已过时：订单页早已用 hash 路由，运营要的正是这个。）
 *      不传 `route` 时退回组件内部状态（组件测试与独立挂载用），行为相同、只是不进地址栏。
 * @limitation 一：**编辑态不进 URL**（App.tsx @limitation 一：没有单条商品接口，深链接兑现不了）。
 * @limitation 二：分页是**页码翻页**不是无限滚动（api.ts @limitation 二 同口径）：
 *              商品量在百级，且翻页让"第几页/共几页"始终可见。
 *
 * @see ./view.ts（行视图与校验的真源）；./api.ts（接口层）
 */
import { useCategories } from '../categories/useCategories.js';
import { categoryName } from '../categories/view.js';
import { LIST_SORT_KEYS, LOW_STOCK_THRESHOLD, SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { DEFAULT_PAGE_SIZE, PageSizeSelect, readListParams, SortTh } from '../ui/list-controls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import type { Route } from '../router.js';
import { listProducts, setProductStatus, type AdminApi, type AdminProductLike } from './api.js';
import { StockCell } from './StockCell.js';
import { productRows, STATUS_LABELS, withStatus, withStock, type ProductRow } from './view.js';

/** 筛选态（`all` 是**前端**概念，服务端只接受 active/offline/draft，所以 all = 不传该参数）。 */
type StatusFilter = 'all' | 'active' | 'offline' | 'draft';

export interface ProductsPageProps {
  api: AdminApi;
  /**
   * 去新建 / 编辑（id 为 null = 新建）。
   * @why 第二个参数是**原始 AdminProduct**：契约没有单条商品接口
   *      （`GET /admin/products/{id}` 不存在），编辑页无法自己取数，
   *      所以由列表页把它带过去（App.tsx @limitation 一 同一条理由）。
   */
  onEdit: (id: string | null, source?: AdminProductLike) => void;
  /** 编辑页带回来的成功提示（空串 = 不显示）。 */
  flash?: string;
  /** 当前路由（筛选 / 页码的唯一真源）；不传 = 用组件内部状态（不进地址栏）。 */
  route?: Route | undefined;
  /** 改筛选 / 翻页时换地址（App 传 `leave`，脏态拦截同口径）。 */
  onNavigate?: ((next: Route) => void) | undefined;
}

/** 地址栏里的参数名（短：地址栏是给人看和复制的）。 */
const Q = {
  status: 'status',
  q: 'q',
  low: 'low',
  page: 'page',
  sort: 'sort',
  size: 'size',
} as const;
const STATUS_VALUES: readonly StatusFilter[] = ['all', 'active', 'offline', 'draft'];

export function ProductsPage({ api, onEdit, flash = '', route, onNavigate }: ProductsPageProps) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  // AJ-491：分类列显示名称（来自后台分类列表；认不出原样显示键）
  const { list: categories } = useCategories(api);
  /** 服务端原始条目（编辑页要用，@see ProductsPageProps.onEdit）。 */
  const [raw, setRaw] = useState<AdminProductLike[]>([]);
  const [total, setTotal] = useState(0);
  /** 不传 route 时的内部"地址栏"。 */
  const [localQuery, setLocalQuery] = useState(() => new URLSearchParams());
  const query = route?.query ?? localQuery;
  const statusRaw = query.get(Q.status) ?? 'all';
  const status: StatusFilter = (STATUS_VALUES as readonly string[]).includes(statusRaw)
    ? (statusRaw as StatusFilter)
    : 'all';
  const pageRaw = Number(query.get(Q.page) ?? '1');
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const applied = query.get(Q.q) ?? '';
  const lowStock = query.get(Q.low) === '1';
  // 评估 4.5 / 4.6（2026-10-09）：排序与每页条数同样进地址栏（ui/list-controls.tsx）
  const { sortKey, sortDir, size: pageSize } = readListParams(query, LIST_SORT_KEYS.products);
  const sortStr = sortKey === null ? '' : `${sortDir === 'desc' ? '-' : ''}${sortKey}`;
  /**
   * 改地址栏参数（与订单页 `patch` 同口径）：等于默认值的键直接删掉；改筛选时页码回到 1 由调用方传 `page: '1'`。
   * ⚠️ 进了 `load` 的依赖：必须稳定——`query` 在同一路由下是同一个实例，`onNavigate` 由外层固定。
   */
  const patch = useCallback(
    (next: Partial<Record<(typeof Q)[keyof typeof Q], string>>): void => {
      const q = new URLSearchParams(query);
      for (const [key, value] of Object.entries(next)) {
        const drop =
          value === undefined ||
          value === '' ||
          (key === Q.status && value === 'all') ||
          (key === Q.page && value === '1') ||
          (key === Q.low && value === '0') ||
          (key === Q.size && value === String(DEFAULT_PAGE_SIZE));
        if (drop) q.delete(key);
        else q.set(key, value);
      }
      if (onNavigate !== undefined) onNavigate({ page: 'products', id: '', query: q });
      else setLocalQuery(q);
    },
    [query, onNavigate],
  );
  const [loading, setLoading] = useState(false);
  /** 列表取数失败（反馈走 Toast；这里只用来区分"空"与"取不到"，审查 2026-10-09 / ui/adoption）。 */
  const [failed, setFailed] = useState(false);
  /** 正在执行上下架的商品 id（按钮禁用态，空串 = 没有）。 */
  const [busyId, setBusyId] = useState('');
  /** 搜索框（未提交）与已生效的关键词；库存紧张筛选（三端联动 UI 模拟 2026-10-08）。 */
  const [keyword, setKeyword] = useState(applied);
  // 地址栏里的关键词变了（后退 / 打开别人发来的链接）→ 输入框跟着变
  useEffect(() => setKeyword(applied), [applied]);
  /**
   * 待确认上下架的商品 id（三端联动模拟 2026-10-08）。
   * @why 原先一点即生效，且生效后列表按更新时间重排、被操作的行跳到第一行——
   *      原位置换成了另一件商品，连点两下就会误下架（或误上架）另一件。改成两步：点一下出「确认」，再点才生效。
   */
  const [confirmId, setConfirmId] = useState('');
  /** 本页全部反馈的出口：内联改库存（AJ-403）、上下架失败、列表加载失败（审查 2026-10-09 起统一走 Toast）。 */
  const sink = useToasts();
  // 编辑页带回来的"已保存…"同样走 Toast（成功 3 秒自动消失，与本页其余反馈同一出口）
  useEffect(() => {
    if (flash !== '') sink.success(flash);
  }, [flash, sink.success]);

  /**
   * 请求序号（A-05）：翻页 / 切筛选时，晚到的旧响应不得覆盖新状态。
   * 只有最后一次发起的请求可以写列表。
   */
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await listProducts(api, {
        page,
        size: pageSize,
        ...(sortStr !== '' ? { sort: sortStr } : {}),
        ...(status === 'all' ? {} : { status }),
        ...(applied !== '' ? { keyword: applied } : {}),
        ...(lowStock ? { lowStock: true } : {}),
      });
      if (seq !== reqSeq.current) return;
      setRaw(res.items);
      setRows(productRows(res.items));
      setTotal(res.total);
      setFailed(false);
      // 扫描 A-02：当前页超出最后一页（例如在"已下架"筛选里把最后一页唯一一件上架）→ 拉回最后一页
      const last = Math.max(1, Math.ceil(res.total / pageSize));
      if (page > last) patch({ [Q.page]: String(last) });
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // ⚠️ 失败**不清列表**（@why 见文件头）：只报错，列表保留上一次的结果
      setFailed(true);
      const { text, traceId } = toastError(e, '商品列表加载失败');
      sink.error(text, { traceId });
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [api, page, status, applied, lowStock, patch, sink.error, pageSize, sortStr]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 上下架：乐观更新（先翻 UI 再发请求），失败则回滚并报错。 */
  const toggle = useCallback(
    async (row: ProductRow) => {
      const next = row.online ? 'offline' : 'active';
      setBusyId(row.id);
      // 三个状态字段一起改（`withStatus`）：只翻 online / status 的话状态列文案会留在旧值（AJ-231）
      setRows((prev) => prev.map((r) => (r.id === row.id ? withStatus(r, next) : r)));
      try {
        await setProductStatus(api, row.id, next);
        // 服务端上下架会刷新 updated_at（A-03）：不重新取列表，编辑页拿到的就是旧值，
        // 保存时撞上自己的乐观锁报 40914「被别人改过了」。
        void load();
      } catch (e) {
        // ⚠️ 回滚：不回滚的表现是"UI 说已下架、服务端还在售"，而列表下一次刷新才暴露
        setRows((prev) => prev.map((r) => (r.id === row.id ? withStatus(r, row.status) : r)));
        const { text, traceId } = toastError(e, row.online ? '下架失败' : '上架失败');
        sink.error(text, { traceId });
      } finally {
        setBusyId('');
      }
    },
    [api, load, sink.error],
  );

  /** 内联改库存成功：就地改这一行（原始条目 + 展示行），不重取列表（StockCell @limitation 一）。 */
  const onStockSaved = useCallback((id: string, stock: number) => {
    setRaw((prev) => prev.map((p) => (p.id === id ? { ...p, stock } : p)));
    setRows((prev) => prev.map((r) => (r.id === id ? withStock(r, stock) : r)));
  }, []);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const onSort = (s: string): void => patch({ [Q.sort]: s, [Q.page]: '1' });

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">商品管理</h1>
        <button type="button" className="btn" onClick={() => onEdit(null)}>
          新建商品
        </button>
      </header>

      <div className="filters">
        {(['all', 'active', 'draft', 'offline'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={s === status ? 'chip chip-on' : 'chip'}
            aria-pressed={s === status}
            onClick={() => patch({ [Q.status]: s, [Q.page]: '1' })}
          >
            {s === 'all' ? '全部' : STATUS_LABELS[s]}
          </button>
        ))}
        <button
          type="button"
          className={lowStock ? 'chip chip-on' : 'chip'}
          aria-pressed={lowStock}
          onClick={() => patch({ [Q.low]: lowStock ? '0' : '1', [Q.page]: '1' })}
        >
          库存紧张（≤ {LOW_STOCK_THRESHOLD}）
        </button>
        <input
          className="input"
          placeholder="搜商品名 / 日文名 / JAN 码"
          maxLength={SEARCH_KEYWORD_MAX_LENGTH}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              patch({ [Q.q]: keyword.trim(), [Q.page]: '1' });
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => patch({ [Q.q]: keyword.trim(), [Q.page]: '1' })}
        >
          搜索
        </button>
      </div>

      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      {loading && <p className="muted">加载中…</p>}
      {!loading && rows.length === 0 && !failed && (
        <p className="muted">
          {applied !== '' || lowStock || status !== 'all' ? (
            <>
              没有符合条件的商品{' '}
              {/* 一键回到默认（全入口点击测试 2026-10-12：筛空了只说"没有"，新手不记得开过哪个筛选） */}
              <button
                type="button"
                className="link"
                onClick={() => patch({ [Q.status]: 'all', [Q.low]: '0', [Q.q]: '', [Q.page]: '1' })}
              >
                清除筛选
              </button>
            </>
          ) : (
            '还没有商品'
          )}
        </p>
      )}

      <table className="table table-actions-reserve">
        <thead>
          <tr>
            <th aria-label="图片" />
            <th>商品</th>
            <th>分类</th>
            <SortTh
              label="售价"
              sortKey="price_jpy"
              currentKey={sortKey ?? 'updated_at'}
              currentDir={sortDir}
              onSort={onSort}
            />
            <SortTh
              label="库存"
              sortKey="stock"
              currentKey={sortKey ?? 'updated_at'}
              currentDir={sortDir}
              onSort={onSort}
            />
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.thumb !== '' ? (
                  <img className="thumb" src={row.thumb} alt="" loading="lazy" />
                ) : (
                  <span className="thumb thumb-empty">无图</span>
                )}
              </td>
              <td>
                {/* 最多两行、悬停看全文（全入口点击测试 2026-10-12：255 字的礼盒名把一行撑成 7 行） */}
                <div className="item-name clamp-2" title={row.title}>
                  {row.title}
                </div>
              </td>
              <td className="muted cell-nowrap">{categoryName(categories, row.category)}</td>
              <td className="cell-nowrap">{row.priceText}</td>
              <StockCell
                api={api}
                sink={sink}
                id={row.id}
                stock={raw.find((r) => r.id === row.id)?.stock}
                stockText={row.stockText}
                lowStock={row.lowStock}
                onSaved={onStockSaved}
                onRefresh={() => void load()}
              />
              <td className={row.online ? 'ok cell-nowrap' : 'muted cell-nowrap'}>
                {row.statusText}
              </td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    onEdit(
                      row.id,
                      raw.find((r) => r.id === row.id),
                    )
                  }
                >
                  编辑
                </button>
                {confirmId === row.id ? (
                  <>
                    <button
                      type="button"
                      // 全入口点击测试 2026-10-11：确认下架用危险色（会让买家买不到；原与「编辑」长得一样）
                      className={row.online ? 'link link-danger' : 'link'}
                      disabled={busyId === row.id}
                      onClick={() => {
                        setConfirmId('');
                        void toggle(row);
                      }}
                    >
                      {row.online ? '确认下架' : '确认上架'}
                    </button>
                    <button type="button" className="link" onClick={() => setConfirmId('')}>
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="link"
                    disabled={busyId === row.id}
                    onClick={() => setConfirmId(row.id)}
                  >
                    {row.online ? '下架' : '上架'}
                  </button>
                )}
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
          onClick={() => patch({ [Q.page]: String(Math.max(1, page - 1)) })}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {lastPage} 页 · 共 {total} 件
        </span>
        <PageSizeSelect
          size={pageSize}
          onChange={(n) => patch({ [Q.size]: String(n), [Q.page]: '1' })}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page >= lastPage}
          onClick={() => patch({ [Q.page]: String(page + 1) })}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
