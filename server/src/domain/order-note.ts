/**
 * 职责：订单内部备注正文的准入判定（第一批⑤，AJ-396）——纯函数，无外部依赖。
 *
 * @why 空白判定用 JS `trim()`：它去掉的是 ECMAScript 的 WhiteSpace + LineTerminator，含全角空格 U+3000。
 *      @measured Node 22.22.2：`'\u3000'.trim() === ''`、`'\u00a0\ufeff'.trim() === ''`。
 *      中文 / 日文输入法下误按出的全角空格是"看着像有字"的空白里最常见的一种。
 * @why 存**去掉首尾空白**之后的正文、中间换行原样保留：备注常是多行（把微信里的来回贴进来），
 *      首尾空行没有信息量，却会让时间线上的气泡凭空变高。
 * @why 两种失败分开给 reason（`order_note_required` / `order_note_too_long`）：进日志，要能一眼分清。
 *      两者都回 40001（参数格式错），与 `releaseReasonGuard` 同口径。
 * @limitation 长度按 UTF-16 码元计（shared `ORDER_NOTE_MAX_LENGTH` 的 @limitation）：emoji 记 2。
 * @limitation 不做内容过滤（脏话、手机号）：内部备注只给管理员看，不进日志正文（审计 after 走 redact），
 *      也不发给买家。若将来要把备注同步给买家，必须另起一条"对外文案"字段，不能复用本字段。
 * @see packages/shared/src/limits.ts；migrations/034_order_notes.sql（库里的同口径兜底 CHECK）
 */
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';

export type OrderNoteResult =
  | { ok: true; body: string }
  | { ok: false; code: 40001; reason: 'order_note_required' | 'order_note_too_long' };

export function orderNoteGuard(raw: unknown): OrderNoteResult {
  if (typeof raw !== 'string') return { ok: false, code: 40001, reason: 'order_note_required' };
  const body = raw.trim();
  if (body === '') return { ok: false, code: 40001, reason: 'order_note_required' };
  if (body.length > ORDER_NOTE_MAX_LENGTH) {
    return { ok: false, code: 40001, reason: 'order_note_too_long' };
  }
  return { ok: true, body };
}
