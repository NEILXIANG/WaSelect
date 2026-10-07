// @vitest-environment jsdom
/** 全局停售开关面板（AJ-384）。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { SalesPausePanel } from './SalesPausePanel.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('SalesPausePanel', () => {
  it('正常接单 → 填原因 → 两步确认暂停 → PUT paused=true，页面变成"已暂停接单"', async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    let paused = false;
    const api = async (req: { method?: string; body?: unknown }): Promise<unknown> => {
      calls.push(req);
      if (req.method === 'PUT') paused = (req.body as { paused: boolean }).paused;
      return { paused, reason: '价格录错', actor: 'admin:u-1', updated_at: '2026-10-06T03:00:00Z' };
    };
    mounted = await mount(createElement(SalesPausePanel, { api: api as never }));
    const el = mounted.el;
    expect(el.textContent).toContain('正常接单');
    await click(button(el, '暂停接单'));
    await click(button(el, '确认暂停接单'));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(el.textContent).toContain('请填写原因');
    await type(el.querySelector('input[name="sales-pause-reason"]'), '价格录错');
    await click(button(el, '确认暂停接单'));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      paused: true,
      reason: '价格录错',
    });
    expect(el.textContent).toContain('已暂停接单');
  });

  it('🔴 P2-48 打开页面后别人已暂停 → 这边点"确认暂停"：先重取，发现已是暂停 → 不发 PUT，提示并刷新', async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    let paused = false;
    const api = async (req: { method?: string; body?: unknown }): Promise<unknown> => {
      calls.push(req);
      if (req.method === 'PUT') paused = (req.body as { paused: boolean }).paused;
      return { paused, reason: '库存错乱', actor: 'admin:u-2', updated_at: '2026-10-06T03:00:00Z' };
    };
    mounted = await mount(createElement(SalesPausePanel, { api: api as never }));
    const el = mounted.el;
    await click(button(el, '暂停接单'));
    paused = true; // 另一位管理员在这期间暂停了
    await type(el.querySelector('input[name="sales-pause-reason"]'), '价格录错');
    await click(button(el, '确认暂停接单'));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false); // 旧实现会发 paused:false（翻转成恢复）
    expect(el.textContent).toContain('已经是该状态（可能刚被其他管理员修改）');
    expect(el.textContent).toContain('已暂停接单');
  });
});
