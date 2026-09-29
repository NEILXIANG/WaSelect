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
 * @see ./view.ts（校验）；./api.ts；../api/upload.ts（图片上传）
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/errors.js';
import { uploadImage } from '../api/upload.js';
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
  bannerFormErrors,
  bannerFormModel,
  bannerRows,
  emptyBannerForm,
  toBannerInput,
} from './view.js';

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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const items = await listBanners(api);
      setRaw(items);
      setRows(bannerRows(items));
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

  const startNew = (): void => {
    setEditing(null);
    setForm(emptyBannerForm());
    setErrors({});
  };

  const startEdit = (b: BannerLike): void => {
    setEditing(b);
    setForm(bannerFormModel(b));
    setErrors({});
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
      else await updateBanner(api, editing.id, body);
      setError('');
      startNew();
      await load();
    } catch (e) {
      // ⚠️ 失败保留表单（清了等于让运营重传一遍图）
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
    setBusy(true);
    try {
      // 0.6.8 起上传响应恒带 image_key（= detail 档键，AJ-143/AJ-166），直接提交；
      // 服务端拿它与 IMG_BASE_URL 拼出 Banner.image 的完整 URL。
      const set = await uploadImage({ baseUrl, getToken, onUnauthorized }, file);
      setForm((s) => ({ ...s, imageKey: set.image_key }));
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
        <button type="button" className="btn" onClick={startNew}>
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
            <th>起止（JST）</th>
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
          <span className="label">图片（上传后得到 image_key，不支持手填）</span>
          <input
            className="input"
            type="file"
            accept="image/*"
            onChange={(e) => void onPickFile(e.target.files?.[0])}
          />
          <span className="muted">{form.imageKey === '' ? '未上传' : form.imageKey}</span>
          {errors['imageKey'] !== undefined && <span className="error">{errors['imageKey']}</span>}
        </div>

        <div className="row2">
          <select
            className="input"
            value={form.linkType}
            onChange={(e) => setForm((s) => ({ ...s, linkType: e.target.value }))}
          >
            {LINK_TYPES.map((t) => (
              <option key={t} value={t}>
                {LINK_LABELS[t]}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="目标 id（商品 id / 分类 key）"
            value={form.linkId}
            onChange={(e) => setForm((s) => ({ ...s, linkId: e.target.value }))}
          />
          <input
            className="input"
            placeholder="排序（小的在前）"
            value={form.sort}
            onChange={(e) => setForm((s) => ({ ...s, sort: e.target.value }))}
          />
          <input
            className="input"
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => setForm((s) => ({ ...s, startsAt: e.target.value }))}
          />
          <input
            className="input"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm((s) => ({ ...s, endsAt: e.target.value }))}
          />
          <label className="label">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((s) => ({ ...s, active: e.target.checked }))}
            />
            启用
          </label>
        </div>

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
