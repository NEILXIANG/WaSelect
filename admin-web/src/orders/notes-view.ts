/**
 * 职责：订单详情**时间线**的纯函数（第一批⑤，AJ-396）——系统事件与内部备注按时间混排、备注输入校验。
 *
 * @why 混排在前端做（不让服务端把备注塞进 `events`）：`events` 是状态机时间线，契约里它的每一行都有
 *      `status`；把人写的备注混进去，所有按 status 读事件的地方（中文化、筛选）都要学会跳过它。
 * @why 同一时刻**事件排在备注前**：备注通常是"对刚发生的事的说明"（先退款、再写为什么），
 *      反过来读会像先解释后发生。排序稳定（`Array.prototype.sort` 自 ES2019 起保证稳定）。
 * @limitation 时间取不出（at 缺失 / 非法）的条目排在最前而不是丢掉：丢掉会把"发生过什么"吃掉，
 *             排最前至少让人看见它（与 `eventStatusText` "认不出的原样保留"同口径）。
 * @see ./OrderTimeline.tsx；packages/shared/src/limits.ts（ORDER_NOTE_MAX_LENGTH）
 */
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';

export interface OrderEventLike {
  status?: string;
  note?: string;
  actor?: string;
  at?: string;
}

/** 契约 `OrderNote`（0.6.42）。 */
export interface OrderNote {
  id: string;
  author: string;
  author_email?: string;
  body: string;
  created_at: string;
}

export type TimelineEntry =
  | { kind: 'event'; at: string | undefined; event: OrderEventLike }
  | { kind: 'note'; at: string; note: OrderNote };

function ms(at: string | undefined): number {
  const t = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** 事件与备注按时间升序混排；同刻事件在前（@see 文件头 @why 二）。 */
export function mergeTimeline(
  events: readonly OrderEventLike[],
  notes: readonly OrderNote[],
): TimelineEntry[] {
  const all: TimelineEntry[] = [
    ...events.map((e): TimelineEntry => ({ kind: 'event', at: e.at, event: e })),
    ...notes.map((n): TimelineEntry => ({ kind: 'note', at: n.created_at, note: n })),
  ];
  return all.sort((a, b) => ms(a.at) - ms(b.at));
}

/** 备注作者的显示名：有邮箱用邮箱，没有就显示 `admin:<id>` 原文（不编一个"未知"）。 */
export function noteAuthorText(n: OrderNote): string {
  return n.author_email !== undefined && n.author_email !== '' ? n.author_email : n.author;
}

/**
 * 备注输入的即时校验（与服务端 `orderNoteGuard` 同口径：去首尾空白后 1–上限）。
 * @returns `ok:false` 时 `message` 是给运营看的中文；空输入不算"错"，只是按钮不可点（`empty`）。
 */
export function noteInputCheck(
  text: string,
): { ok: true; body: string } | { ok: false; empty: boolean; message: string } {
  const body = text.trim();
  if (body === '') return { ok: false, empty: true, message: '备注不能为空' };
  if (body.length > ORDER_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      empty: false,
      message: `备注最多 ${String(ORDER_NOTE_MAX_LENGTH)} 字（当前 ${String(body.length)}）`,
    };
  }
  return { ok: true, body };
}
