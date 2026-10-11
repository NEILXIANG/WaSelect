/**
 * 售后申请面板的纯函数（AJ-420）：中文化、可做的动作、说明校验、冲突文案。
 */
import { describe, expect, it } from 'vitest';
import { afterSaleConflictText, afterSaleRows, resolveNoteHint } from './after-sale-view.js';

const base = {
  id: 'as-1',
  reason: 'damaged',
  description: '外箱压扁，罐子凹了',
  status: 'open',
  created_at: '2026-10-08T03:00:00.000Z',
  updated_at: '2026-10-08T03:00:00.000Z',
};

describe('afterSaleRows', () => {
  it('原因 / 状态翻成中文；进行中的可标记处理中', () => {
    const [r] = afterSaleRows({ after_sales: [base] });
    expect(r).toMatchObject({
      reasonText: '商品破损',
      statusText: '已提交，等待处理',
      open: true,
      canMarkProcessing: true,
      resolutionText: '',
    });
    expect(r?.timeText).toContain('2026');
  });

  it('🔴 处理中不能再"标记处理中"；结案行不再 open；说明不拼内部账号 id（谁处理的看时间线，那里是邮箱）', () => {
    const rows = afterSaleRows({
      after_sales: [
        { ...base, id: 'a', status: 'processing' },
        {
          ...base,
          id: 'b',
          status: 'resolved',
          resolution_note: '已部分退款',
          handled_by: 'admin:u-1',
        },
      ],
    });
    expect(rows.map((r) => [r.id, r.open, r.canMarkProcessing])).toEqual([
      ['a', true, false],
      ['b', false, false],
    ]);
    // 三端模拟测试 2026-10-11（用户截图指出）：原先拼成「已部分退款（admin:adm-d2b4185c-…）」，运营读不懂
    expect(rows[1]?.resolutionText).toBe('已部分退款');
  });

  it('认不出的行（缺 id / 状态不在枚举）丢掉；没有 after_sales 键 → 空', () => {
    expect(
      afterSaleRows({
        after_sales: [
          { ...base, id: 1 },
          { ...base, status: 'closed' },
          { ...base, status: 'constructor' },
        ],
      }),
    ).toEqual([]);
    expect(afterSaleRows({})).toEqual([]);
    expect(afterSaleRows(null)).toEqual([]);
  });
});

describe('resolveNoteHint / afterSaleConflictText', () => {
  it('说明：空白 → 提示；恰好 500 字放行；501 字 → 提示', () => {
    expect(resolveNoteHint('  ')).toContain('请写处理说明');
    expect(resolveNoteHint('あ'.repeat(500))).toBeNull();
    expect(resolveNoteHint('あ'.repeat(501))).toContain('500');
  });

  it('40902 reason → 中文；其它 → null', () => {
    expect(afterSaleConflictText('after_sale_closed')).toContain('已经结案');
    expect(afterSaleConflictText('transition_invalid')).toContain('状态已变化');
    expect(afterSaleConflictText('status_not_allowed')).toBeNull();
  });
});
