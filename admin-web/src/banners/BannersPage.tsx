/**
 * 职责：Banner 管理页（列表 + 新建 / 编辑 / 删除 / 上下线）。
 *
 * @why 列表页**整条带过来编辑**（`onEdit` 传原始 `BannerLike`）而不是只传 id
 *      再去拉单条：契约**没有** `GET /admin/banners/{id}`，
 *      传 id 就得再拉一次整个列表然后自己 find——那是一次无谓的往返。
 *      （与商品管理 App.tsx @limitation 一 同一条理由。）
 *
 * @limitation 一：删除是**两步确认**而不是直接删：Banner 没有回收站，
 *      删掉只能重传图片再配一遍，而误点的代价是首页空白一段时间。
 * @limitation 二：`image_key` 由上传得到（表单里**不手填**）：
 *      手填的 key 多半不存在，服务端存了也不报错，直到首页图裂了才发现。
 *
 * @why 40914（编辑期间被别人改过）原地保留表单，给「加载最新值对照」（P2-44）：
 *      旧文案让人"取消编辑后重新打开"，那会丢掉表单与刚上传的图。载入后版本凭据换成最新一版，
 *      核对后再保存 = 用你的内容覆盖最新一版。
 *
 * @limitation 三：页面级反馈（加载 / 保存 / 删除 / 上传的成败）走 `ui/Toast`（审查 2026-10-09，ui/adoption 欠账清单）；
 *              字段级校验仍在字段旁行内显示（附件 §5：错误要显示在出错的那个字段旁边）。
 *
 * @see ./view.ts（校验）；./api.ts；../api/upload.ts（图片上传）
 */
import { useCategories } from '../categories/useCategories.js';
import { categoryName, categoryOptions } from '../categories/view.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { UPLOAD_ACCEPT, uploadImage } from '../api/upload.js';
import { findProductById, listProducts, type AdminProductLike } from '../products/api.js';
import {
  createBanner,
  deleteBanner,
  listBanners,
  updateBanner,
  type AdminApi,
  type BannerLike,
} from './api.js';
import {
  LINK_LABELS,
  LINK_TYPES,
  bannerConflictRows,
  bannerFormErrors,
  bannerFormModel,
  bannerRows,
  emptyBannerForm,
  toBannerInput,
} from './view.js';
import { sameForm, useFormDirty } from '../ui/unsaved.js';
import { LEAVE_UNSAVED_SPEC } from '../ui/leave-spec.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';

export interface BannersPageProps {
  api: AdminApi;
  /** 上传要用（multipart 不走通用封装）。 */
  baseUrl: string;
  getToken: () => string;
  /** 上传遇 40101 时的出口（与通用封装同一语义：清 token 回登录页，KD-13）。 */
  onUnauthorized?: (() => void) | undefined;
}

export function BannersPage({ api, baseUrl, getToken, onUnauthorized }: BannersPageProps) {
  const [raw, setRaw] = useState<BannerLike[]>([]);
  /** 商品 id → 商品名（列表与按 id 补查合在一起）。 */
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  // AJ-491：分类名称与「目标分类」下拉来自后台分类列表；分类晚到时列表文案跟着更新（所以 rows 在渲染时算）
  const { list: categories } = useCategories(api);
  const rows = useMemo(
    () =>
      bannerRows(
        raw,
        (id) => titles.get(id),
        (k) => categoryName(categories, k),
      ),
    [raw, titles, categories],
  );
  const [editing, setEditing] = useState<BannerLike | null>(null);
  const [form, setForm] = useState(emptyBannerForm());
  /** 「未改动基线」：新建 / 打开编辑 / 保存成功后跟着 `form` 一起重置（第一批⑥）。 */
  const [pristine, setPristine] = useState(emptyBannerForm());
  useFormDirty(form, pristine);
  // 页内切换编辑对象（新建 / 编辑另一条 / 取消编辑）不经 App 的 leave()，脏态要在这里自己拦（审查 2026-10-09 #2）
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const guarded = (fn: () => void): void => {
    if (sameForm(form, pristine)) fn();
    else setPendingSwitch(() => fn);
  };
  /**
   * 点「新建 / 编辑」后把焦点送到表单标题（全入口点击测试 2026-10-12：表单在列表下面，点了页面不动、
   * 焦点不动，看着像没反应）。只在用户点按钮时跳；保存 / 删除后内部回到"新建"不跳。
   */
  const formTitleRef = useRef<HTMLHeadingElement>(null);
  const [jump, setJump] = useState(0);
  useEffect(() => {
    if (jump === 0) return;
    formTitleRef.current?.scrollIntoView?.({ block: 'start' });
    formTitleRef.current?.focus();
  }, [jump]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 页面级反馈出口（原页面顶部那行红字，审查 2026-10-09 起统一走 Toast）。 */
  const sink = useToasts();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  /** 40914 冲突态与载入的最新一版（只读对照，P2-44）。 */
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<BannerLike | null>(null);
  /**
   * 跳转目标的候选商品（三端联动 UI 模拟 2026-10-08）：原先要运营手填商品内部 id——列表上根本看不到 id。
   * 取前 100 件（管理端商品量在百级，与 findProductById 同口径）；取不到就退回手填。
   */
  const [products, setProducts] = useState<{ id: string; title: string; online: boolean }[]>([]);
  /**
   * 目标商品的搜索（代理 S5，第二轮审计 2026-10-11）：下拉框只装得下一页（服务端 size 上限 100）。
   * @why 商品一多，排在 100 件之后的商品原先根本选不到；编辑一条指向它的 Banner 时下拉框显示"请选择商品"，像没选。
   */
  const [productQuery, setProductQuery] = useState('');
  const [productTotal, setProductTotal] = useState(0);
  /** 当前表单图片的预览（上传结果或正在编辑那条的现图）。 */
  const [preview, setPreview] = useState('');
  /**
   * 当前表单对应哪一条（'new' = 新建）。上传完成时拿它核对（A-07）：
   * 上传要几秒，期间运营可能点了另一条的「编辑」；不核对的话，图会写进**另一条**的表单。
   */
  const formTarget = useRef('new');
  formTarget.current = editing?.id ?? 'new';

  /** 按商品名搜目标商品（S5）：结果替换下拉框选项；失败只报错、不清已有选项。 */
  const searchProducts = async (): Promise<void> => {
    try {
      const keyword = productQuery.trim();
      const res = await listProducts(api, { size: 100, ...(keyword === '' ? {} : { keyword }) });
      const opts = toProductOptions(res.items);
      setProducts(opts);
      setProductTotal(Number.isInteger(res.total) ? res.total : opts.length);
    } catch (e) {
      const { text, traceId } = toastError(e, '商品搜索失败');
      sink.error(text, { traceId });
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    sink.error('');
    try {
      const [items, plist] = await Promise.all([
        listBanners(api),
        listProducts(api, { size: 100 }).catch(() => ({ items: [], total: 0 })),
      ]);
      const opts = toProductOptions(plist.items);
      setProducts(opts);
      setProductTotal(Number.isInteger(plist.total) ? plist.total : opts.length);
      // 三端模拟测试 2026-10-11：候选只有前 100 件，链到更早商品的 Banner 会退回显示 36 位 id——缺的按 id 往后翻页补名字
      //   （Banner 只有几条，逐个补的请求量可以忽略；补不到的仍退回显示 id，不编名字）
      const titles = new Map(opts.map((o) => [o.id, o.title]));
      const missing = [
        ...new Set(
          (Array.isArray(items) ? (items as unknown as Array<Record<string, unknown>>) : [])
            .filter((b) => b['link_type'] === 'product' && typeof b['link_id'] === 'string')
            .map((b) => b['link_id'] as string)
            .filter((id) => !titles.has(id)),
        ),
      ];
      const found = await Promise.allSettled(missing.map((id) => findProductById(api, id)));
      found.forEach((r, i) => {
        const id = missing[i];
        if (r.status === 'fulfilled' && r.value !== null && id !== undefined)
          titles.set(id, String(r.value.title ?? ''));
      });
      setRaw(items);
      setTitles(titles);
    } catch (e) {
      // ⚠️ 失败不清列表（同其它页）：只报错
      const { text, traceId } = toastError(e, 'Banner 列表加载失败');
      sink.error(text, { traceId });
    } finally {
      setLoading(false);
    }
  }, [api, sink.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearConflict = (): void => {
    setConflict(false);
    setLatest(null);
  };

  const startNew = (): void => {
    clearConflict();
    setEditing(null);
    const fresh = emptyBannerForm();
    setForm(fresh);
    setPristine(fresh);
    setErrors({});
    setPreview('');
  };

  const startEdit = (b: BannerLike): void => {
    clearConflict();
    setEditing(b);
    const model = bannerFormModel(b);
    setForm(model);
    setPristine(model);
    setErrors({});
    setPreview(typeof b['image'] === 'string' ? b['image'] : '');
  };

  const save = async (): Promise<void> => {
    const check = bannerFormErrors(form);
    setErrors(check.errors);
    if (!check.ok) {
      sink.error(check.first);
      return;
    }
    setBusy(true);
    try {
      const body = toBannerInput(form);
      if (editing === null) await createBanner(api, body);
      // 带上打开编辑时的版本（S-09）：期间被别人改过时服务端回 40914，而不是静默覆盖
      else
        await updateBanner(api, editing.id, {
          ...body,
          expected_updated_at: editing.updated_at ?? '',
        });
      sink.error('');
      startNew();
      await load();
    } catch (e) {
      // ⚠️ 失败保留表单（清了等于让运营重传一遍图）
      const isConflict = e instanceof ApiError && e.code === 40914;
      if (isConflict) {
        setConflict(true);
        setLatest(null);
      }
      const { text, traceId } = toastError(e, '保存失败');
      sink.error(
        isConflict
          ? `${text}：你填的内容都还在。请点「加载最新值对照」看对方改了什么，核对后再保存`
          : text,
        { traceId },
      );
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = async (): Promise<void> => {
    if (editing === null) return;
    setBusy(true);
    try {
      const items = await listBanners(api);
      const fresh = items.find((b) => b.id === editing.id);
      if (fresh === undefined) {
        sink.error('列表里已找不到这条 Banner（可能已被删除）：你填的内容还在');
        return;
      }
      setLatest(fresh);
      // 换成最新一版的凭据（表单不动）：之后保存 = 看过对方改动后，用你的内容覆盖
      setEditing({
        ...editing,
        ...(fresh.updated_at !== undefined ? { updated_at: fresh.updated_at } : {}),
      });
      sink.error('');
    } catch (e) {
      const { text, traceId } = toastError(e, '取最新值失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await deleteBanner(api, id);
      setConfirmDelete('');
      // G6（AJ-472）：删的正是在编辑的那条 → 表单回到"新建"，否则再保存会 PUT 一个不存在的 id（40402）
      if (editing?.id === id) startNew();
      await load();
    } catch (e) {
      const { text, traceId } = toastError(e, '删除失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const target = formTarget.current;
    setBusy(true);
    try {
      // 0.6.8 起上传响应恒带 image_key（= detail 档键，AJ-143/AJ-166），直接提交；
      // 服务端拿它与 IMG_BASE_URL 拼出 Banner.image 的完整 URL。
      const set = await uploadImage({ baseUrl, getToken, onUnauthorized }, file);
      if (formTarget.current !== target) {
        sink.error('上传完成时你已切换到另一条 Banner，这张图没有放进当前表单；如需使用请重新选择');
        return;
      }
      setForm((s) => ({ ...s, imageKey: set.image_key }));
      setPreview(set.card ?? set.detail ?? '');
      setErrors((e) => ({ ...e, imageKey: '' }));
    } catch (e) {
      const { text, traceId } = toastError(e, '图片上传失败');
      sink.error(text, { traceId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">首页 Banner</h1>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() =>
            guarded(() => {
              startNew();
              setJump((n) => n + 1);
            })
          }
        >
          新建
        </button>
      </header>

      {loading && <p className="muted">加载中…</p>}
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />

      <table className="table table-actions-reserve">
        <thead>
          <tr>
            <th>排序</th>
            <th>图</th>
            <th>跳转</th>
            <th>状态</th>
            <th>起止（日本时间）</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.sortText}</td>
              <td>
                {r.imageUrl === '' ? (
                  <span className="muted">—</span>
                ) : (
                  <img className="thumb-img" src={r.imageUrl} alt="" />
                )}
              </td>
              <td>{r.linkText}</td>
              <td className={r.active ? 'ok' : 'muted'}>{r.active ? '启用' : '停用'}</td>
              <td className="muted">{r.periodText === '' ? '不限' : r.periodText}</td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    const found = raw.find((b) => b.id === r.id);
                    if (found !== undefined)
                      guarded(() => {
                        startEdit(found);
                        setJump((n) => n + 1);
                      });
                  }}
                >
                  编辑
                </button>
                {confirmDelete === r.id ? (
                  <>
                    <button
                      type="button"
                      className="link link-danger"
                      disabled={busy}
                      onClick={() => void remove(r.id)}
                    >
                      确认删除
                    </button>
                    <button type="button" className="link" onClick={() => setConfirmDelete('')}>
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" className="link" onClick={() => setConfirmDelete(r.id)}>
                    删除
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading && (
            <tr>
              <td className="muted" colSpan={6}>
                还没有 Banner
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="form">
        {/* 标题说"第几条、跳到哪"，不写内部 id（全入口点击测试 2026-10-12） */}
        <h2 className="title" id="banner-form-title" ref={formTitleRef} tabIndex={-1}>
          {editing === null ? '新建 Banner' : editingTitle(rows, editing.id)}
        </h2>

        <div className="field">
          <span className="label">图片（建议横图 2.5:1，如 1500×600）</span>
          <input
            className="input"
            type="file"
            accept={UPLOAD_ACCEPT}
            onChange={(e) => void onPickFile(e.target.files?.[0])}
          />
          {preview !== '' ? (
            <img className="banner-preview" src={preview} alt="Banner 预览" />
          ) : (
            <span className="muted">{form.imageKey === '' ? '未上传' : '已上传（暂无预览）'}</span>
          )}
          {errors['imageKey'] !== undefined && <span className="error">{errors['imageKey']}</span>}
        </div>

        {/* 每个输入都带标签（三端联动 UI 模拟 2026-10-08：原先排序框只写"0"、两个时间框分不清起止） */}
        <div className="row2">
          <label className="field">
            <span className="label">点击跳转到</span>
            <select
              className="input"
              value={form.linkType}
              onChange={(e) => setForm((s) => ({ ...s, linkType: e.target.value, linkId: '' }))}
            >
              {LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LINK_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          {form.linkType === 'product' && products.length > 0 && (
            <div className="field">
              <span className="label">搜索商品</span>
              <div className="row">
                <input
                  className="input"
                  aria-label="搜索商品"
                  placeholder="按商品名搜索"
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void searchProducts();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void searchProducts()}
                >
                  搜索商品
                </button>
              </div>
              {productTotal > products.length && (
                <span className="muted">
                  下拉框里只列出 {products.length} 件（共 {productTotal}{' '}
                  件），找不到请先按商品名搜索
                </span>
              )}
            </div>
          )}
          {form.linkType === 'product' && products.length > 0 && (
            <label className="field">
              <span className="label">目标商品</span>
              <select
                className="input"
                value={form.linkId}
                onChange={(e) => setForm((s) => ({ ...s, linkId: e.target.value }))}
              >
                <option value="">请选择商品</option>
                {/* S5：当前指向的商品不在这一页里（排在后面 / 搜索结果没有它）→ 仍列出来，下拉框不至于显示"请选择商品" */}
                {form.linkId !== '' && !products.some((p) => p.id === form.linkId) && (
                  <option value={form.linkId}>当前：{form.linkId}</option>
                )}
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.online ? '' : '（已下架）'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.linkType === 'category' && (
            <label className="field">
              <span className="label">目标分类</span>
              <select
                className="input"
                value={form.linkId}
                onChange={(e) => setForm((s) => ({ ...s, linkId: e.target.value }))}
              >
                <option value="">请选择分类</option>
                {categoryOptions(categories, form.linkId).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.linkType === 'product' && products.length === 0 && (
            <label className="field">
              <span className="label">目标商品 id（商品列表取不到时手填）</span>
              <input
                className="input"
                value={form.linkId}
                onChange={(e) => setForm((s) => ({ ...s, linkId: e.target.value }))}
              />
            </label>
          )}
        </div>
        <div className="row2">
          <label className="field">
            <span className="label">排序（数字小的排前面）</span>
            <input
              className="input"
              inputMode="numeric"
              placeholder="排序（小的在前）"
              value={form.sort}
              onChange={(e) => setForm((s) => ({ ...s, sort: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="label">开始时间（日本时间，留空 = 立即）</span>
            <input
              className="input"
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm((s) => ({ ...s, startsAt: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="label">结束时间（日本时间，留空 = 不结束）</span>
            <input
              className="input"
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm((s) => ({ ...s, endsAt: e.target.value }))}
            />
          </label>
          <label className="label">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((s) => ({ ...s, active: e.target.checked }))}
            />
            启用
          </label>
        </div>

        {conflict && latest === null && editing !== null && (
          <button type="button" className="btn" disabled={busy} onClick={() => void loadLatest()}>
            加载最新值对照
          </button>
        )}
        {latest !== null && (
          <table className="table">
            <thead>
              <tr>
                <th>字段（≠ 为不同）</th>
                <th>你填的</th>
                <th>最新值（只读）</th>
              </tr>
            </thead>
            <tbody>
              {bannerConflictRows(form, latest).map((r) => (
                <tr key={r.label} className={r.differs ? 'error' : undefined}>
                  <td>
                    {r.differs ? '≠ ' : ''}
                    {r.label}
                  </td>
                  <td>{r.mine}</td>
                  <td>{r.latest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {Object.values(errors)
          .filter((v) => v !== '')
          .map((v) => (
            <span className="error" key={v}>
              {v}
            </span>
          ))}

        <div className="row2">
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            {busy ? '提交中…' : '保存'}
          </button>
          {editing !== null && (
            <button type="button" className="link" onClick={() => guarded(startNew)}>
              取消编辑
            </button>
          )}
        </div>
      </div>
      {pendingSwitch !== null && (
        <ConfirmDialog
          spec={LEAVE_UNSAVED_SPEC}
          onConfirm={() => {
            const fn = pendingSwitch;
            setPendingSwitch(null);
            fn();
          }}
          onCancel={() => setPendingSwitch(null)}
        />
      )}
    </section>
  );
}

/** 商品列表行 → 下拉框选项（S5：首屏与搜索共用一份映射）。 */
function toProductOptions(
  items: ReadonlyArray<Pick<AdminProductLike, 'id' | 'title' | 'status'>>,
): { id: string; title: string; online: boolean }[] {
  return items.map((p) => ({
    id: String(p.id),
    title: String(p.title ?? ''),
    online: p.status === 'active',
  }));
}

/** 编辑态标题：列表里的第几条 + 跳到哪（找不到时只写"编辑 Banner"，不退回内部 id）。 */
function editingTitle(rows: ReadonlyArray<{ id: string; linkText: string }>, id: string): string {
  const i = rows.findIndex((r) => r.id === id);
  const r = rows[i];
  return r === undefined ? '编辑 Banner' : `编辑第 ${String(i + 1)} 条 Banner（${r.linkText}）`;
}
