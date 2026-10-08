/**
 * 职责：订单详情的**时间线**（第一批⑤，AJ-396）——系统事件与内部备注按时间混排，底部追加备注。
 *
 * @why 独立成组件：OrderDetail 已 600 行；备注有自己的取数、草稿与提交状态，
 *      混在详情页里会让"详情刷新"与"备注刷新"互相牵连（发货后不需要重取备注，追加备注后也不需要重取订单）。
 * @why 备注**自己取数**（`GET …/notes`），不随详情一起回来：详情接口是契约里已稳定的 `AdminOrder`，
 *      为了一个只在本页用的列表改它的形状，会波及列表页与导出的形状校验。
 * @why 取备注失败只在时间线里**行内**说一句（带报障码），不弹 Toast、不挡整页：
 *      备注是辅助信息，取不到不该让"发货 / 退款"这些主操作看起来像坏了。
 * @why 追加成功后**把服务端回来的那一条**并进列表，不重取：append-only，服务端回什么就是什么。
 * @limitation 没有改 / 删：表是 append-only（迁移 034），写错了再追加一条更正——按钮旁写明了这一点。
 * @limitation 草稿不进"未保存离开提醒"（第一批⑥只管商品与 Banner 表单）；离开页面草稿会丢。
 * @see ./notes-view.ts；./api.ts（listOrderNotes / addOrderNote）；server/src/app/admin-order-note-routes.ts
 */
import { useCallback, useEffect, useState } from 'react';
import { useFormDirty } from '../ui/unsaved.js';
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';
import { formatJst } from '../format.js';
import { toastError } from '../ui/toast.js';
import { addOrderNote, listOrderNotes, type AdminApi } from './api.js';
import {
  mergeTimeline,
  noteAuthorText,
  noteInputCheck,
  type OrderEventLike,
  type OrderNote,
} from './notes-view.js';
import { eventStatusText } from './view.js';

export interface OrderTimelineProps {
  api: AdminApi;
  orderId: string;
  events: readonly OrderEventLike[];
  onError: (text: string, traceId: string | undefined) => void;
  onSuccess: (text: string) => void;
}

export function OrderTimeline({ api, orderId, events, onError, onSuccess }: OrderTimelineProps) {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  /** 取备注失败的行内说明（含报障码）；'' = 没失败。 */
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState('');
  // 只填空格不算草稿（与「添加备注」按钮的禁用口径一致）
  useFormDirty(draft.trim(), '');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setNotes(await listOrderNotes(api, orderId));
      setLoadErr('');
    } catch (e) {
      const { text, traceId } = toastError(e, '取备注失败');
      setLoadErr(traceId !== undefined && traceId !== '' ? `${text}（报障码 ${traceId}）` : text);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = noteInputCheck(draft);

  const submit = async (): Promise<void> => {
    if (!check.ok) {
      if (!check.empty) onError(check.message, undefined);
      return;
    }
    setBusy(true);
    try {
      const added = await addOrderNote(api, orderId, check.body);
      setNotes((list) => [...list, added]);
      setDraft('');
      onSuccess('备注已添加');
    } catch (e) {
      const { text, traceId } = toastError(e, '添加备注失败');
      onError(text, traceId);
    } finally {
      setBusy(false);
    }
  };

  const entries = mergeTimeline(events, notes);

  return (
    <div className="field">
      <span className="label">时间线</span>
      {entries.length === 0 && <span className="muted">—</span>}
      {entries.map((t, i) =>
        t.kind === 'event' ? (
          <span className="muted" key={`e${String(i)}`}>
            {/* `eventStatusText` 而不是 `e.status`：事件流里有一半是"没迁状态、只记一件事"的伪状态 */}
            {formatJst(t.event.at)} {eventStatusText(t.event.status)} {t.event.note ?? ''}
          </span>
        ) : (
          <div className="timeline-note" key={`n${t.note.id}`}>
            <span className="muted">
              {formatJst(t.note.created_at)} 内部备注 · {noteAuthorText(t.note)}
            </span>
            <span className="timeline-note-body">{t.note.body}</span>
          </div>
        ),
      )}
      {loadErr !== '' && <span className="error">{loadErr}</span>}

      <textarea
        className="input"
        placeholder="内部备注（仅管理员可见，买家看不到；如：微信里买家说周五后再发）"
        maxLength={ORDER_NOTE_MAX_LENGTH}
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {!check.ok && !check.empty && <span className="error">{check.message}</span>}
      <button
        type="button"
        className="btn"
        disabled={busy || !check.ok}
        onClick={() => void submit()}
      >
        添加备注
      </button>
      <span className="muted">备注提交后不能修改或删除；写错了请再追加一条更正。</span>
    </div>
  );
}
