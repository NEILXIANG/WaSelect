/**
 * 职责：「商品分类」页顶部的新建表单（AJ-491）。
 * @why 代码（键）与名称分开填、写明用途：代码会进小程序网址与 Banner 跳转，建好后不能改；名称是买家看到的字。
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import { halfWidth } from '../format.js';
import { toastError, type ToastSink } from '../ui/toast.js';
import { createCategory, type AdminApi } from './api.js';
import { categoryDraftErrors, categoryServerError } from './view.js';

export function CategoryCreateForm({
  api,
  sink,
  onCreated,
}: {
  api: AdminApi;
  sink: ToastSink;
  onCreated: () => Promise<void>;
}): React.JSX.Element {
  const [d, setD] = useState({ key: '', name: '', sort: '100' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const e = categoryDraftErrors(d, true);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy(true);
    try {
      await createCategory(api, {
        key: d.key.trim(),
        name: d.name.trim(),
        sort: Number(halfWidth(d.sort)),
      });
      sink.success(`已新建分类「${d.name.trim()}」——有在售商品后小程序才会显示它`);
      setD({ key: '', name: '', sort: '100' });
      await onCreated();
    } catch (err) {
      const f = err instanceof ApiError ? categoryServerError(err.data) : null;
      if (f !== null) setErrors({ [f.field]: f.text });
      // 认得出的字段错误（重名、格式）是运营自己能改的，不给报障编号（全入口点击测试 2026-10-12；同登录页 3c6d8c8）
      if (f !== null) sink.error(f.text);
      else {
        const t = toastError(err, '新建分类失败');
        sink.error(t.text, { traceId: t.traceId });
      }
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: 'name' | 'key' | 'sort',
    label: string,
    placeholder: string,
    hint: string,
  ) => (
    <label className="field">
      <span className="label">{label}</span>
      <input
        className="input"
        name={`category-${name}`}
        value={d[name]}
        placeholder={placeholder}
        onChange={(e) => setD({ ...d, [name]: e.target.value })}
      />
      {errors[name] !== undefined ? (
        <span className="error">{errors[name]}</span>
      ) : (
        <span className="muted">{hint}</span>
      )}
    </label>
  );

  return (
    <div className="filters category-create">
      {field('name', '分类名称', '如：母婴用品', '买家在小程序里看到的名字，最多 10 个字')}
      {field('key', '分类代码', '如：baby_care', '小写英文字母开头，建好后不能改')}
      {field('sort', '排序', '100', '越小越靠前')}
      <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
        新建分类
      </button>
    </div>
  );
}
