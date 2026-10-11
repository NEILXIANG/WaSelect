/**
 * 职责：「商品分类」表格的一行（AJ-491）——展示、行内改名改序、启停、删除入口。
 * @why 「买家端」一列说清看不看得到、为什么：成熟后台把"为什么前台没显示"直接写在列表里，运营不用去小程序里验证。
 */
import { useState } from 'react';
import { Badge } from '../ui/badge.js';
import type { AdminCategory } from './api.js';
import { categoryDraftErrors } from './view.js';

export function buyerVisibility(c: AdminCategory): {
  text: string;
  tone: 'success' | 'muted' | 'warn';
} {
  if (!c.active) return { text: '已停用', tone: 'muted' };
  if (c.active_product_count === 0) return { text: '已隐藏（暂无在售商品）', tone: 'warn' };
  return { text: '显示中', tone: 'success' };
}

export function CategoryRow({
  c,
  busy,
  onSave,
  onToggle,
  onDelete,
}: {
  c: AdminCategory;
  busy: boolean;
  onSave: (patch: { name: string; sort: number }) => Promise<boolean>;
  onToggle: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [edit, setEdit] = useState<{ name: string; sort: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const vis = buyerVisibility(c);

  const save = async (): Promise<void> => {
    if (edit === null) return;
    const e = categoryDraftErrors({ key: c.key, ...edit }, false);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    if (await onSave({ name: edit.name.trim(), sort: Number(edit.sort.trim()) })) setEdit(null);
  };

  return (
    <tr>
      <td className="cell-nowrap">
        {edit === null ? (
          c.sort
        ) : (
          <input
            className="input input-narrow"
            name="edit-sort"
            value={edit.sort}
            onChange={(e) => setEdit({ ...edit, sort: e.target.value })}
          />
        )}
        {errors['sort'] !== undefined && <span className="error">{errors['sort']}</span>}
      </td>
      <td>
        {edit === null ? (
          c.name
        ) : (
          <input
            className="input"
            name="edit-name"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
        )}
        {errors['name'] !== undefined && <span className="error">{errors['name']}</span>}
      </td>
      <td className="mono muted">{c.key}</td>
      <td className="cell-nowrap">
        {c.active_product_count} / {c.product_count}
      </td>
      <td className="cell-nowrap">
        <Badge tone={vis.tone}>{vis.text}</Badge>
      </td>
      <td className="cell-nowrap action-cell">
        {edit === null ? (
          <>
            <button
              type="button"
              className="link"
              data-act="edit"
              disabled={busy}
              onClick={() => setEdit({ name: c.name, sort: String(c.sort) })}
            >
              编辑
            </button>
            <button type="button" className="link" disabled={busy} onClick={onToggle}>
              {c.active ? '停用' : '启用'}
            </button>
            <button
              type="button"
              className="link"
              data-act="delete"
              disabled={busy || c.product_count > 0}
              title={
                c.product_count > 0
                  ? `还有 ${String(c.product_count)} 件商品，不能删；不想让买家看到可以停用`
                  : ''
              }
              onClick={onDelete}
            >
              删除
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link" disabled={busy} onClick={() => void save()}>
              保存
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setEdit(null);
                setErrors({});
              }}
            >
              取消
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
