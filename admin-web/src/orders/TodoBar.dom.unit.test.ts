// @vitest-environment jsdom
/** 订单待办计数（三端联动 UI 模拟 2026-10-08）。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
import { TodoBar } from './TodoBar.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('TodoBar', () => {
  it('🔴 按状态 / 待处理类取 total 显示计数；点一格回调对应的查询条件；某格取数失败显示 —，不影响其它格', async () => {
    const totals: Record<string, number> = {
      'status=paid': 3,
      // 与订单页「待付款」页签同一个状态集合（三端联动模拟 2026-10-10：原先只数 pending_payment，
      // 工作台说"待付款 0"、点进订单页「待付款」页签却有单）
      'status=created,pending_payment': 1,
      'attention=after_sale': 2,
      'attention=late_paid': 0,
      'attention=blocked': 1,
    };
    const picked: Array<Record<string, string>> = [];
    mounted = await mount(
      createElement(TodoBar, {
        api: (async (req: { path: string }) => {
          const p = new URLSearchParams(req.path.split('?')[1]);
          const key = p.has('attention')
            ? `attention=${p.get('attention') ?? ''}`
            : `status=${p.get('status') ?? ''}`;
          if (!(key in totals)) throw new Error('boom');
          return { items: [], total: totals[key] };
        }) as never,
        current: 'all',
        onPick: (q: Record<string, string>) => picked.push(q),
      }),
    );
    await flush();
    const el = mounted.el;
    expect(el.textContent).toContain('待发货 3');
    expect(el.textContent).toContain('待付款 1');
    expect(el.textContent).toContain('退款中 —');
    // AJ-425：三类"有人负责却没人看得到"的单进待办
    expect(el.textContent).toContain('售后待处理 2');
    expect(el.textContent).toContain('迟到付款待退 0');
    expect(el.textContent).toContain('拉黑用户的已付单 1');
    // AJ-410 / N7：每格是带「去处理 →」的按钮；有待办的格用提醒色
    const due = button(el, '待发货 3 · 去处理 →');
    expect(due?.className).toContain('todo-chip-due');
    expect(button(el, '退款中 — · 去处理 →')?.className).not.toContain('todo-chip-due');
    expect(button(el, '迟到付款待退 0 · 去处理 →')?.className).not.toContain('todo-chip-due');
    await click(due);
    await click(button(el, '售后待处理 2 · 去处理 →'));
    await click(button(el, '待付款 1 · 去处理 →'));
    expect(picked).toEqual([
      { status: 'paid' },
      { attention: 'after_sale' },
      { status: 'created,pending_payment' },
    ]);
  });
});
