/**
 * 职责：后台「商品分类」管理页（AJ-491，用户 2026-10-11 要求分类可配置）。
 *
 * @why 参照成熟电商后台的分类管理：一张表列出全部分类（含停用），说清每类在买家端显不显示、为什么；
 *      顶部新建；行内改名 / 排序；还有商品的分类不能删（提示改为停用）。
 * @why 「停用」要两步（体验审查 2026-10-15，P2-6），且与「删除」同一套 `ConfirmDialog danger`：
 *      它是**改一个布尔字段**，看着比删除轻，可对买家端的影响是即时的（首页少一整个分类），
 *      而后果原先只在**成功之后**的 Toast 里才说——运营按下按钮时并不知道会发生什么。
 *      「启用」是低风险动作（把东西加回来），保持一键。
 * @limitation 只有一级分类；排序靠数字，不支持拖拽（分类是个位到十几个的量级，数字够用）。
 * @see ./CategoryRow.tsx；./CategoryCreateForm.tsx；server/src/app/admin-category-routes.ts
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { deleteCategory, updateCategory, type AdminApi, type AdminCategory } from './api.js';
import { CategoryCreateForm } from './CategoryCreateForm.js';
import { CategoryRow } from './CategoryRow.js';
import { refreshCategories, useCategories } from './useCategories.js';
import { categoryServerError } from './view.js';

export function CategoriesPage({ api }: { api: AdminApi }): React.JSX.Element {
  const sink = useToasts();
  const { list, error } = useCategories(api, { fresh: true });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  /** 待确认停用的分类（P2-6）；null = 没开确认框。 */
  const [deactivating, setDeactivating] = useState<AdminCategory | null>(null);

  const reload = async (): Promise<void> => {
    await refreshCategories(api).catch((e: unknown) => {
      const t = toastError(e, '分类列表刷新失败');
      sink.error(t.text, { traceId: t.traceId });
    });
  };

  const run = async (fn: () => Promise<void>, ok: string, fallback: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      sink.success(ok);
      await reload();
      return true;
    } catch (e) {
      const f = e instanceof ApiError ? categoryServerError(e.data) : null;
      // 认得出的字段错误（重名、格式）不给报障编号：不是技术故障（同 CategoryCreateForm）
      if (f !== null) sink.error(f.text);
      else {
        const t = toastError(e, fallback);
        sink.error(t.text, { traceId: t.traceId });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h1 className="title">商品分类</h1>
      <p className="muted">
        小程序首页只显示「启用」且有在售商品的分类，按排序从小到大；一件在售商品都没有的分类会自动隐藏。
      </p>
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
      <CategoryCreateForm api={api} sink={sink} onCreated={reload} />
      {error && <p className="error">分类列表加载失败，请刷新页面重试</p>}
      <table className="table">
        <thead>
          <tr>
            <th>排序</th>
            <th>分类名称</th>
            <th>分类代码</th>
            <th>在售 / 全部商品</th>
            <th>买家端</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <CategoryRow
              key={c.key}
              c={c}
              busy={busy}
              onSave={(patch) =>
                run(() => updateCategory(api, c.key, patch), `已保存「${patch.name}」`, '保存失败')
              }
              onToggle={() => {
                // 停用 = 会立刻改变买家端，先确认（P2-6）；启用是把东西加回来，一键即可
                if (c.active) setDeactivating(c);
                else
                  void run(
                    () => updateCategory(api, c.key, { active: true }),
                    `已启用「${c.name}」`,
                    '操作失败',
                  );
              }}
              onDelete={() => setDeleting(c)}
            />
          ))}
        </tbody>
      </table>
      {deactivating !== null && (
        <ConfirmDialog
          spec={{
            title: `停用分类「${deactivating.name}」`,
            // ⚠️ 后果说在**确认之前**（P2-6 规律⑦）：原先它在成功之后的 Toast 里，
            //    而那时买家端已经少了一整个分类。
            body: '停用后小程序首页不再显示这个分类；其中的商品仍能在「全部」和搜索里买到。要停卖请到商品管理下架。',
            confirmText: '确认停用',
            danger: true,
          }}
          busy={busy}
          onConfirm={() => {
            const c = deactivating;
            setDeactivating(null);
            void run(
              () => updateCategory(api, c.key, { active: false }),
              `已停用「${c.name}」：其中的商品仍能在「全部」和搜索里买到，要停卖请到商品管理下架`,
              '操作失败',
            );
          }}
          onCancel={() => setDeactivating(null)}
        />
      )}
      {deleting !== null && (
        <ConfirmDialog
          spec={{
            title: `删除分类「${deleting.name}」`,
            body: '删除后不能恢复；这个分类下没有任何商品。',
            confirmText: '确认删除',
            danger: true,
          }}
          busy={busy}
          onConfirm={() => {
            const c = deleting;
            setDeleting(null);
            void run(() => deleteCategory(api, c.key), `已删除「${c.name}」`, '删除失败');
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
