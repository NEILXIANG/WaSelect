/**
 * 职责：商品列表的**库存单元格**——显示库存与「紧张」标记，点「改库存」就地改（AJ-403，对标 §4.3「库存视图」）。
 *
 * @why 带 `expected_stock` 乐观锁（契约 0.6.46 `PATCH /admin/products/{id}/stock`）：
 *      凭据就是**列表上显示的那个数**——运营看着 3 改成 30，期间若有人买走一件，库里是 2，
 *      不带凭据的绝对值覆盖会把那次扣减抹掉、多卖一件不存在的货。
 * @why 40914 时**保留运营填的值**、不自动重取：自动重取会让输入框旁的"当前库存"悄悄变掉，
 *      运营以为自己改的是 3 → 30，实际确认的是 2 → 30；让他点「刷新」看见新数再决定，才算"看过再覆盖"。
 *      刷新只重取列表，本组件按商品 id 保持挂载，正在填的值不丢（ProductsPage 的行 key 是 id）。
 * @why 操作结果走 Toast（第一批①的统一出口）；**输入格式错**留在单元格里（字段级行内校验，adoption 门禁同口径）。
 *
 * @limitation 一：「库存紧张」筛选开着时把库存改大，这一行不会立刻从列表消失（下次刷新才走）——
 *              立刻移走会让运营找不到刚改的那一行确认结果。
 * @limitation 二：只改库存，不碰其它字段与 `updated_at`；所以同时开着的编辑页**不会**因此 40914，
 *              除非编辑页也改了库存（那时它带的 expected_stock 对不上，正该拦）。
 *
 * @see ./api.ts（setProductStock）；./view.ts（parseStockEdit / withStock）
 */
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import { toastError, type ToastSink } from '../ui/toast.js';
import { setProductStock, type AdminApi } from './api.js';
import { parseStockEdit } from './view.js';

export interface StockCellProps {
  api: AdminApi;
  sink: ToastSink;
  id: string;
  /** 服务端下发的库存（乐观锁凭据）；不是整数时不允许改（没有凭据可带）。 */
  stock: unknown;
  stockText: string;
  lowStock: boolean;
  onSaved: (id: string, stock: number) => void;
  /** 冲突后的「刷新」：重取列表（本组件的输入值保留）。 */
  onRefresh: () => void;
}

export function StockCell(p: StockCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const canEdit = Number.isInteger(p.stock);

  const save = async (): Promise<void> => {
    const parsed = parseStockEdit(draft);
    if (!parsed.ok) {
      setFieldError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const r = await setProductStock(p.api, p.id, parsed.value, p.stock as number);
      p.onSaved(p.id, r.stock);
      p.sink.success(`库存已改为 ${String(r.stock)}`);
      setEditing(false);
      setConflict(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 40914) {
        setConflict(true);
        p.sink.error(
          `库存在你看到之后变了（可能有新订单扣减）：你填的 ${draft.trim()} 还在，请点「刷新」看最新库存后再保存`,
          { traceId: e.traceId },
        );
      } else {
        const t = toastError(e, '改库存失败');
        p.sink.error(t.text, { traceId: t.traceId });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <td className={p.lowStock ? 'error' : undefined}>
        {p.stockText}
        {p.lowStock ? '（紧张）' : ''}
        <button
          type="button"
          className="link"
          disabled={!canEdit}
          onClick={() => {
            setDraft(String(p.stock));
            setFieldError('');
            setConflict(false);
            setEditing(true);
          }}
        >
          改库存
        </button>
      </td>
    );
  }
  return (
    <td>
      <input
        className="input stock-input"
        inputMode="numeric"
        aria-label="新库存"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setFieldError('');
        }}
      />
      <button type="button" className="link" disabled={busy} onClick={() => void save()}>
        保存库存
      </button>
      {conflict && (
        <button type="button" className="link" disabled={busy} onClick={p.onRefresh}>
          刷新
        </button>
      )}
      <button type="button" className="link" disabled={busy} onClick={() => setEditing(false)}>
        放弃
      </button>
      {fieldError !== '' && <span className="error">{fieldError}</span>}
    </td>
  );
}
