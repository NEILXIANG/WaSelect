/**
 * 职责：订单详情里的「售后申请」面板（AJ-420）——列出买家提交的申请，进行中的可"标记处理中"或填说明结案。
 *
 * @why 没有申请时**整块不渲染**：绝大多数订单没有售后，一个"暂无售后申请"的空框只会占地方。
 * @why 结案（已处理 / 未通过）必须写说明，按钮在说明不合法时禁用并行内提示：买家在小程序里看到的就是这句话。
 * @why 写操作后交给父页 `reload` 刷新整页详情（与发货 / 退款同口径：状态以服务端为准）。
 * @limitation 一：不联动退款——要退钱请用右栏「部分退款 / 全额退款」，再回来写说明结案（服务端同样不耦合）。
 * @why 结案（已处理 / 不予处理）先二次确认：结案后买家立刻看到说明、且不能撤回（统一结论 5.4，原先点了即提交）。
 * @why 说明草稿进"未保存离开提醒"（与内部备注同口径，OrderTimeline 也登记了草稿）。
 * @see ./after-sale-view.ts；server/src/app/after-sale-routes.ts
 */
import { useState } from 'react';
import { AFTER_SALE_DESCRIPTION_MAX } from '@waselect/shared';
import { ApiError } from '../api/errors.js';
import { toastError } from '../ui/toast.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { useFormDirty } from '../ui/unsaved.js';
import { resolveAfterSale, type AdminApi } from './api.js';
import {
  afterSaleConflictText,
  afterSaleRows,
  resolveNoteHint,
  type AfterSaleRowView,
} from './after-sale-view.js';

export interface AfterSalesProps {
  api: AdminApi;
  orderId: string;
  order: unknown;
  reload: () => unknown;
  onError: (text: string, traceId?: string) => void;
  onSuccess: (text: string) => void;
}

export function AfterSales({ api, orderId, order, reload, onError, onSuccess }: AfterSalesProps) {
  const rows = afterSaleRows(order);
  if (rows.length === 0) return null;
  return (
    <div className="field" aria-label="售后申请">
      <span className="label">售后申请</span>
      {rows.map((r) => (
        <AfterSaleRow key={r.id} row={r} {...{ api, orderId, reload, onError, onSuccess }} />
      ))}
    </div>
  );
}

function AfterSaleRow({
  row,
  api,
  orderId,
  reload,
  onError,
  onSuccess,
}: Omit<AfterSalesProps, 'order'> & { row: AfterSaleRowView }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** 等待二次确认的结案动作；null = 没有弹框。 */
  const [pending, setPending] = useState<'resolved' | 'rejected' | null>(null);
  const hint = resolveNoteHint(note);
  useFormDirty(note.trim(), '');

  const act = async (status: 'processing' | 'resolved' | 'rejected'): Promise<void> => {
    setBusy(true);
    try {
      await resolveAfterSale(api, orderId, row.id, {
        status,
        ...(status === 'processing' ? {} : { note: note.trim() }),
      });
      setNote('');
      onSuccess(
        status === 'processing' ? '已标记为处理中' : '已结案，买家可在订单详情里看到处理说明',
      );
    } catch (e) {
      const conflict =
        e instanceof ApiError && e.code === 40902
          ? afterSaleConflictText(e.data?.['reason'])
          : null;
      if (conflict !== null) onError(conflict);
      else {
        const { text, traceId } = toastError(e, '处理售后申请失败');
        onError(text, traceId);
      }
    } finally {
      setBusy(false);
      await reload();
    }
  };

  return (
    <div className={row.open ? 'after-sale after-sale-open' : 'after-sale'}>
      <span>
        <strong>{row.reasonText}</strong> · {row.statusText} ·{' '}
        <span className="muted">{row.timeText}</span>
      </span>
      <span className="selectable">{row.description}</span>
      {row.resolutionText !== '' && <span className="muted">处理说明：{row.resolutionText}</span>}
      {row.open && (
        <>
          <textarea
            className="input"
            placeholder="处理说明（买家可见；如：已安排部分退款 1,500 日元，3–5 个工作日到账）"
            // 浏览器 maxLength 按 UTF-16 码元数，服务端按字数（统一结论 5.4）：
            // @measured: Chrome 152，maxLength=2 的输入框里打两个 😀，只留下 1 个（value.length=2、字数=1）。
            // 放到 2 倍：任何 500 字以内的说明都不超过 1000 码元，不挡合法输入，仍能拦住误粘贴的超长内容；
            // 真正的上限由 resolveNoteHint（按字数）提示并禁用结案按钮
            maxLength={AFTER_SALE_DESCRIPTION_MAX * 2}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {hint !== null && note !== '' && <span className="error">{hint}</span>}
          {/* 还没写时用灰字说明按钮为什么点不了（第三轮走查 2026-10-12：禁用却不说原因，运营点了没反应）；
              不用红字：还没开始写不算出错 */}
          {note === '' && (
            <span className="muted after-sale-hint">
              写好处理说明才能结案（买家会在订单详情里看到这句话）
            </span>
          )}
          <span className="row-actions">
            {row.canMarkProcessing && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void act('processing')}
              >
                标记处理中
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy || hint !== null}
              onClick={() => setPending('resolved')}
            >
              已处理，结案
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || hint !== null}
              onClick={() => setPending('rejected')}
            >
              不予处理，结案
            </button>
          </span>
          {pending !== null && (
            <ConfirmDialog
              spec={{
                title: pending === 'resolved' ? '按「已处理」结案' : '按「不予处理」结案',
                body: `买家会在订单详情里看到这段说明，结案后不能修改：「${note.trim()}」`,
                confirmText: '确认结案',
                danger: pending === 'rejected',
              }}
              busy={busy}
              onConfirm={() => {
                const s = pending;
                setPending(null);
                void act(s);
              }}
              onCancel={() => setPending(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
