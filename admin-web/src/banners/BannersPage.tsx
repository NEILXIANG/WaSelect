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
 * @see ./view.ts（校验）；./api.ts；../api/upload.ts（图片上传）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { UPLOAD_ACCEPT, uploadImage } from '../api/upload.js';
import { PRODUCT_CATEGORY } from '@waselect/shared';
import { listProducts } from '../products/api.js';
import { CATEGORY_LABELS } from '../products/view.js';
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
import { useFormDirty } from '../ui/unsaved.js';

export interface BannersPageProps {
  api: AdminApi;
  /** 上传要用（multipart 不走通用封装）。 */
  baseUrl: string;
  getToken: () => string;
  /** 上传遇 40101 时的出口（与通用封装同一语义：清 token 回登录页，KD-13）。 */
  onUnauthorized?: (() => void) | undefined;
}

export function BannersPage({ api, baseUrl, getToken, onUnauthorized }: BannersPageProps) {
  const [rows, setRows] = useState<ReturnType<typeof bannerRows>>([]);
  const [raw, setRaw] = useState<BannerLike[]>([]);
  const [editing, setEditing] = useState<BannerLike | null>(null);
  const [form, setForm] = useState(emptyBannerForm());
  /** 「未改动基线」：新建 / 打开编辑 / 保存成功后跟着 `form` 一起重置（第一批⑥）。 */
  const [pristine, setPristine] = useState(emptyBannerForm());
  useFormDirty(form, pristine);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
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
  /** 当前表单图片的预览（上传结果或正在编辑那条的现图）。 */
  const [preview, setPreview] = useState('');
  /**
   * 当前表单对应哪一条（'new' = 新建）。上传完成时拿它核对（A-07）：
   * 上传要几秒，期间运营可能点了另一条的「编辑」；不核对的话，图会写进**另一条**的表单。
   */
  const formTarget = useRef('new');
  formTarget.current = editing?.id ?? 'new';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [items, plist] = await Promise.all([
        listBanners(api),
        listProducts(api, { size: 100 }).catch(() => ({ items: [], total: 0 })),
      ]);
      const opts = plist.items.map((p) => ({
        id: String(p['id']),
        title: String(p['title'] ?? ''),
        online: p['status'] === 'active',
      }));
      setProducts(opts);
      setRaw(items);
      setRows(bannerRows(items, (id) => opts.find((o) => o.id === id)?.title));
    } catch (e) {
      // ⚠️ 失败不清列表（同其它页）：只显示错误
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

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
      setError(check.first);
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
      setError('');
      startNew();
      await load();
    } catch (e) {
      // ⚠️ 失败保留表单（清了等于让运营重传一遍图）
      const isConflict = e instanceof ApiError && e.code === 40914;
      if (isConflict) {
        setConflict(true);
        setLatest(null);
      }
      setError(
        isConflict
          ? `${(e as ApiError).message}：你填的内容都还在。请点「加载最新值对照」看对方改了什么，核对后再保存`
          : e instanceof ApiError
            ? e.message
            : String(e),
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
        setError('列表里已找不到这条 Banner（可能已被删除）：你填的内容还在');
        return;
      }
      setLatest(fresh);
      // 换成最新一版的凭据（表单不动）：之后保存 = 看过对方改动后，用你的内容覆盖
      setEditing({
        ...editing,
        ...(fresh.updated_at !== undefined ? { updated_at: fresh.updated_at } : {}),
      });
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await deleteBanner(api, id);
      setConfirmDelete('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
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
        setError('上传完成时你已切换到另一条 Banner，这张图没有放进当前表单；如需使用请重新选择');
        return;
      }
      setForm((s) => ({ ...s, imageKey: set.image_key }));
      setPreview(set.card ?? set.detail ?? '');
      setErrors((e) => ({ ...e, imageKey: '' }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">首页 Banner</h1>
        <button type="button" className="btn btn-secondary" onClick={startNew}>
          新建
        </button>
      </header>

      {loading && <p className="muted">加载中…</p>}
      {error !== '' && <p className="error">{error}</p>}

      <table className="table">
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
                    if (found !== undefined) startEdit(found);
                  }}
                >
                  编辑
                </button>
                {confirmDelete === r.id ? (
                  <>
                    <button
                      type="button"
                      className="link"
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
        <span className="label">
          {editing === null ? '新建 Banner' : `编辑 Banner（${editing.id}）`}
        </span>

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
            <label className="field">
              <span className="label">目标商品</span>
              <select
                className="input"
                value={form.linkId}
                onChange={(e) => setForm((s) => ({ ...s, linkId: e.target.value }))}
              >
                <option value="">请选择商品</option>
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
                {PRODUCT_CATEGORY.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
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
            <button type="button" className="link" onClick={startNew}>
              取消编辑
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
