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
  it('按状态取 total 显示计数；点一格回调该状态；某格取数失败显示 —，不影响其它格', async () => {
    const totals: Record<string, number> = { paid: 3, pending_payment: 1 };
    const picked: string[] = [];
    mounted = await mount(
      createElement(TodoBar, {
        api: (async (req: { path: string }) => {
          const s = new URLSearchParams(req.path.split('?')[1]).get('status') ?? '';
          if (!(s in totals)) throw new Error('boom');
          return { items: [], total: totals[s] };
        }) as never,
        current: 'all',
        onPick: (s: string) => picked.push(s),
      }),
    );
    await flush();
    const el = mounted.el;
    expect(el.textContent).toContain('待发货 3');
    expect(el.textContent).toContain('待付款 1');
    expect(el.textContent).toContain('退款中 —');
    // AJ-410 / N7：每格是带「去处理 →」的按钮（原按钮文字只有「待发货 3」）；有待办的格用提醒色
    const due = button(el, '待发货 3 · 去处理 →');
    expect(due?.className).toContain('todo-chip-due');
    expect(button(el, '退款中 — · 去处理 →')?.className).not.toContain('todo-chip-due');
    await click(due);
    expect(picked).toEqual(['paid']);
  });
});
