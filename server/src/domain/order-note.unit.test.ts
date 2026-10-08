/**
 * 职责：`domain/order-note.ts`（订单内部备注的正文准入，第一批⑤，AJ-396）的单测 + 边界表。
 *
 * @why 边界表逐格列出 0 / 1 / 上限 / 上限+1 与"全是空白"的几种形态（半角空格、制表、换行、
 *      **全角空格 U+3000**）：中文 / 日文输入法下误按出的全角空格是最常见的"看着像有字"的空白，
 *      漏了它，时间线里会出现一条看不见内容的备注。
 * @why 上限取 shared `ORDER_NOTE_MAX_LENGTH`（不写字面量 1000）：前端 `maxLength` 与服务端判定同源，
 *      写死数字等于把漂移重新放回来（limits.ts 文件头 @why）。
 */
import { describe, expect, it } from 'vitest';
import { ORDER_NOTE_MAX_LENGTH } from '@waselect/shared';
import { orderNoteGuard } from './order-note.js';

describe('orderNoteGuard（订单内部备注正文，AJ-396）', () => {
  it('上限就是 1000（文档 §8-1⑤ 的数字直接成为断言）', () => {
    expect(ORDER_NOTE_MAX_LENGTH).toBe(1000);
  });

  const table: ReadonlyArray<[string, unknown, 'ok' | string]> = [
    ['非字符串（undefined）', undefined, 'order_note_required'],
    ['非字符串（数字）', 12, 'order_note_required'],
    ['空串', '', 'order_note_required'],
    ['只有半角空格', '   ', 'order_note_required'],
    ['只有制表 / 换行', '\t\n\r\n', 'order_note_required'],
    ['只有全角空格 U+3000', '\u3000\u3000', 'order_note_required'],
    ['1 个字', '済', 'ok'],
    ['恰好上限', 'あ'.repeat(ORDER_NOTE_MAX_LENGTH), 'ok'],
    ['上限 + 1', 'あ'.repeat(ORDER_NOTE_MAX_LENGTH + 1), 'order_note_too_long'],
    ['首尾空白不计入长度', ` ${'あ'.repeat(ORDER_NOTE_MAX_LENGTH)}\n`, 'ok'],
  ];

  it.each(table)('🔴 %s', (_name, raw, expected) => {
    const r = orderNoteGuard(raw);
    if (expected === 'ok') {
      expect(r.ok).toBe(true);
      return;
    }
    expect(r).toEqual({ ok: false, code: 40001, reason: expected });
  });

  it('放行时返回去掉首尾空白的正文，中间的换行原样保留（备注常是多行）', () => {
    const r = orderNoteGuard('  买家微信说：\n周五后再发  ');
    expect(r).toEqual({ ok: true, body: '买家微信说：\n周五后再发' });
  });

  it('emoji 按 UTF-16 码元计（比库里 char_length 更严，库约束永远不会先于应用层拒绝）', () => {
    // 500 个 emoji = 1000 个码元（放行）；501 个 = 1002（拒）
    expect(orderNoteGuard('😀'.repeat(500)).ok).toBe(true);
    expect(orderNoteGuard('😀'.repeat(501))).toMatchObject({ reason: 'order_note_too_long' });
  });
});
