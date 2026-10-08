/**
 * 职责：商品列表页（分页 / 筛选 / 上下架 / 去编辑 / 内联改库存）。
 *
 * @why 草稿（AJ-403）与下架共用"上架"按钮：两者对买家都不可见，上架都走同一条 PATCH（同一组 40918 判定）。
 *
 * @why 上下架失败**保留列表**并只显示错误：清空列表的表现是"操作失败连商品都没了"，
 *      运营会以为数据丢了，而实际只是那一次 PATCH 没成功。
 *
 * @limitation 一：**不引入 react-router**——管理端一共四五个页面，
 *              路由库带来的是一整套"URL ↔ 视图"的约定与依赖，而这里只需要
 *              "当前看哪个页"一个 state。引入它的唯一理由是"想用浏览器后退键"，
 *              而管理员的后退键预期是"回到上一步操作"，不是"回到上一个 URL"。
 * @limitation 二：分页是**页码翻页**不是无限滚动（api.ts @limitation 二 同口径）：
 *              商品量在百级，且翻页让"第几页/共几页"始终可见。
 *
 * @see ./view.ts（行视图与校验的真源）；./api.ts（接口层）
 */
import { LOW_STOCK_THRESHOLD, SEARCH_KEYWORD_MAX_LENGTH } from '@waselect/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { ToastStack, useToasts } from '../ui/toast.js';
import { listProducts, setProductStatus, type AdminApi, type AdminProductLike } from './api.js';
import { StockCell } from './StockCell.js';
import { productRows, STATUS_LABELS, withStatus, withStock, type ProductRow } from './view.js';

/** 每页条数（契约默认 50；管理端用 20 让一屏放得下）。 */
const PAGE_SIZE = 20;

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
}

export function ProductsPage({ api, onEdit, flash = '' }: ProductsPageProps) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  /** 服务端原始条目（编辑页要用，@see ProductsPageProps.onEdit）。 */
  const [raw, setRaw] = useState<AdminProductLike[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 正在执行上下架的商品 id（按钮禁用态，空串 = 没有）。 */
  const [busyId, setBusyId] = useState('');
  /** 搜索框（未提交）与已生效的关键词；库存紧张筛选（三端联动 UI 模拟 2026-10-08）。 */
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [lowStock, setLowStock] = useState(false);
  /**
   * 待确认上下架的商品 id（三端联动模拟 2026-10-08）。
   * @why 原先一点即生效，且生效后列表按更新时间重排、被操作的行跳到第一行——
   *      原位置换成了另一件商品，连点两下就会误下架（或误上架）另一件。改成两步：点一下出「确认」，再点才生效。
   */
  const [confirmId, setConfirmId] = useState('');
  /** 内联改库存的反馈出口（AJ-403；本页其余反馈仍是行内，见 ui/adoption 的欠账清单）。 */
  const sink = useToasts();

  /**
   * 请求序号（A-05）：翻页 / 切筛选时，晚到的旧响应不得覆盖新状态。
   * 只有最后一次发起的请求可以写列表。
   */
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError('');
    try {
      const res = await listProducts(api, {
        page,
        size: PAGE_SIZE,
        ...(status === 'all' ? {} : { status }),
        ...(applied !== '' ? { keyword: applied } : {}),
        ...(lowStock ? { lowStock: true } : {}),
      });
      if (seq !== reqSeq.current) return;
      setRaw(res.items);
      setRows(productRows(res.items));
      setTotal(res.total);
      // 扫描 A-02：当前页超出最后一页（例如在"已下架"筛选里把最后一页唯一一件上架）→ 拉回最后一页
      const last = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
      if (page > last) setPage(last);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      // ⚠️ 失败**不清列表**（@why 见文件头）：只显示错误，列表保留上一次的结果
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [api, page, status, applied, lowStock]);

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
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setBusyId('');
      }
    },
    [api, load],
  );

  /** 内联改库存成功：就地改这一行（原始条目 + 展示行），不重取列表（StockCell @limitation 一）。 */
  const onStockSaved = useCallback((id: string, stock: number) => {
    setRaw((prev) => prev.map((p) => (p.id === id ? { ...p, stock } : p)));
    setRows((prev) => prev.map((r) => (r.id === id ? withStock(r, stock) : r)));
  }, []);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {s === 'all' ? '全部' : STATUS_LABELS[s]}
          </button>
        ))}
        <button
          type="button"
          className={lowStock ? 'chip chip-on' : 'chip'}
          onClick={() => {
            setLowStock((v) => !v);
            setPage(1);
          }}
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
              setApplied(keyword.trim());
              setPage(1);
            }
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setApplied(keyword.trim());
            setPage(1);
          }}
        >
          搜索
        </button>
      </div>

      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      {flash !== '' && (
        <p className="ok" role="status">
          {flash}
        </p>
      )}
      {error !== '' && <p className="error">{error}</p>}
      {loading && <p className="muted">加载中…</p>}
      {!loading && rows.length === 0 && error === '' && (
        <p className="muted">{applied !== '' || lowStock ? '没有符合条件的商品' : '还没有商品'}</p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th aria-label="图片" />
            <th>商品</th>
            <th>分类</th>
            <th>售价</th>
            <th>库存</th>
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
              <td>{row.title}</td>
              <td className="muted">{row.categoryLabel}</td>
              <td>{row.priceText}</td>
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
              <td className={row.online ? 'ok' : 'muted'}>{row.statusText}</td>
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
                      className="link"
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
          className="btn"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          上一页
        </button>
        <span className="muted">
          第 {page} / {lastPage} 页 · 共 {total} 件
        </span>
        <button
          type="button"
          className="btn"
          disabled={page >= lastPage}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </footer>
    </section>
  );
}
