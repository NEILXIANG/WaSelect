/**
 * 职责：`notes-view.ts`（时间线混排 / 备注输入校验，第一批⑤，AJ-396）的单测。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';
import { mergeTimeline, noteAuthorText, noteInputCheck, type OrderNote } from './notes-view.js';

const note = (id: string, at: string, extra: Partial<OrderNote> = {}): OrderNote => ({
  id,
  author: 'admin:u-1',
  body: `备注${id}`,
  created_at: at,
  ...extra,
});

describe('mergeTimeline', () => {
  it('事件与备注按时间升序混排', () => {
    const out = mergeTimeline(
      [
        { status: 'paid', at: '2026-10-08T01:00:00Z' },
        { status: 'shipped', at: '2026-10-08T03:00:00Z' },
      ],
      [note('n1', '2026-10-08T02:00:00Z'), note('n0', '2026-10-08T00:30:00Z')],
    );
    expect(out.map((e) => (e.kind === 'event' ? e.event.status : e.note.id))).toEqual([
      'n0',
      'paid',
      'n1',
      'shipped',
    ]);
  });

  it('同一时刻事件在备注前（先发生、后说明）', () => {
    const at = '2026-10-08T01:00:00Z';
    const out = mergeTimeline([{ status: 'refunded', at }], [note('n1', at)]);
    expect(out.map((e) => e.kind)).toEqual(['event', 'note']);
  });

  it('时间缺失的事件不丢，排最前', () => {
    const out = mergeTimeline([{ status: 'x' }], [note('n1', '2026-10-08T01:00:00Z')]);
    expect(out[0]?.kind).toBe('event');
    expect(out).toHaveLength(2);
  });
});

describe('noteAuthorText', () => {
  it('有邮箱用邮箱，没有就显示 admin:<id> 原文', () => {
    expect(noteAuthorText(note('a', 'x', { author_email: 'ops@example.com' }))).toBe(
      'ops@example.com',
    );
    expect(noteAuthorText(note('a', 'x'))).toBe('admin:u-1');
  });
});

describe('noteInputCheck（与服务端 orderNoteGuard 同口径）', () => {
  it('空白（含全角空格）→ empty', () => {
    expect(noteInputCheck(' \u3000\n')).toMatchObject({ ok: false, empty: true });
  });
  it('恰好上限放行（去首尾空白后计数）；上限 + 1 拒并报当前字数', () => {
    expect(noteInputCheck(` ${'a'.repeat(ORDER_NOTE_MAX_LENGTH)} `)).toEqual({
      ok: true,
      body: 'a'.repeat(ORDER_NOTE_MAX_LENGTH),
    });
    const r = noteInputCheck('a'.repeat(ORDER_NOTE_MAX_LENGTH + 1));
    expect(r).toMatchObject({ ok: false, empty: false });
    expect(r.ok ? '' : r.message).toContain(String(ORDER_NOTE_MAX_LENGTH + 1));
  });
});
