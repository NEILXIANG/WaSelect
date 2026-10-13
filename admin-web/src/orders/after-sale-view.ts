/**
 * 职责：订单详情「售后申请」面板的纯函数（AJ-420，契约 0.6.56）——把 `after_sales` 翻成中文行、给出每行能做的动作、
 *       校验处理说明、把 40902 的 reason 翻成运营看得懂的话。
 *
 * @why 原因 / 状态文案从 shared 取（与小程序同一份）：买家选的是"商品破损"，运营看到的也必须是"商品破损"，不是 damaged。
 * @why 认不出的行（缺 id / status）**丢掉**而不是渲染空行：空行上的"处理"按钮点下去只会 40400。
 *      与时间线"认不出也留着"不同——时间线只读，这里每行带写操作。
 * @limitation 只给"当前状态下合法的下一步"按钮（与服务端 afterSaleTransitionAllowed 同一份规则）；
 *             两位运营同时处理时，后点的那位仍会收到 40902（由 afterSaleErrorText 翻译）。
 * @see ./AfterSales.tsx；packages/shared/src/after-sale.ts
 */
import {
  AFTER_SALE_DESCRIPTION_MAX,
  AFTER_SALE_OPEN_STATUSES,
  AFTER_SALE_REASON_LABELS,
  AFTER_SALE_STATUS_LABELS,
  afterSaleTransitionAllowed,
  type AfterSaleReason,
  type AfterSaleStatus,
} from '@waselect/shared';
import { formatJst } from '../format.js';

export interface AfterSaleRowView {
  id: string;
  status: AfterSaleStatus;
  reasonText: string;
  statusText: string;
  description: string;
  timeText: string;
  /** 处理说明 + 处理人（没有为空串）。 */
  resolutionText: string;
  /** 进行中（open / processing）：行高亮，并显示处理表单。 */
  open: boolean;
  canMarkProcessing: boolean;
}

const isStatus = (s: unknown): s is AfterSaleStatus =>
  typeof s === 'string' && Object.prototype.hasOwnProperty.call(AFTER_SALE_STATUS_LABELS, s);

export function afterSaleRows(order: unknown): AfterSaleRowView[] {
  const list = (order as { after_sales?: unknown } | null)?.after_sales;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x): AfterSaleRowView[] => {
    const a = x as Record<string, unknown> | null;
    if (a === null || typeof a['id'] !== 'string' || !isStatus(a['status'])) return [];
    const reason = String(a['reason'] ?? '');
    const note = typeof a['resolution_note'] === 'string' ? a['resolution_note'] : '';
    return [
      {
        id: a['id'],
        status: a['status'],
        reasonText: Object.prototype.hasOwnProperty.call(AFTER_SALE_REASON_LABELS, reason)
          ? AFTER_SALE_REASON_LABELS[reason as AfterSaleReason]
          : reason,
        statusText: AFTER_SALE_STATUS_LABELS[a['status']],
        description: typeof a['description'] === 'string' ? a['description'] : '',
        timeText: typeof a['created_at'] === 'string' ? formatJst(a['created_at']) : '—',
        // 不拼 handled_by：它是内部账号 id（admin:adm-…），运营读不懂；谁处理的看时间线（那里显示邮箱）
        resolutionText: note,
        open: (AFTER_SALE_OPEN_STATUSES as readonly string[]).includes(a['status']),
        canMarkProcessing: afterSaleTransitionAllowed(a['status'], 'processing'),
      },
    ];
  });
}

/** 结案说明校验：空 / 超长给出提示，合法返回 null。 */
export function resolveNoteHint(note: string): string | null {
  const n = [...note.trim()].length;
  if (n === 0) return '请写处理说明（买家会在订单详情里看到这句话）';
  if (n > AFTER_SALE_DESCRIPTION_MAX)
    return `处理说明最多 ${String(AFTER_SALE_DESCRIPTION_MAX)} 字`;
  return null;
}

/** 40902 的 reason → 中文；其它返回 null（交给通用错误文案）。 */
export function afterSaleConflictText(reason: unknown): string | null {
  if (reason === 'after_sale_closed') return '这条申请已经结案（可能别的同事刚处理过），已刷新';
  if (reason === 'transition_invalid') return '这条申请的状态已变化，已刷新，请按最新状态处理';
  return null;
}
