// @vitest-environment jsdom
/** 已拉黑用户列表与解除拉黑（AJ-384）。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { BlockedUsers } from './BlockedUsers.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('BlockedUsers', () => {
  it('列出已拉黑用户 → 点解除 → 原因为空不发请求 → 填原因后发 unblock 并刷新', async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    let blocked = true;
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      calls.push(req);
      if (req.path.endsWith('/unblock')) {
        blocked = false;
        return { already_unblocked: false };
      }
      return {
        items: blocked ? [{ id: 'u-9', blocked_at: '2026-10-06T03:00:00Z', order_count: 2 }] : [],
      };
    };
    mounted = await mount(createElement(BlockedUsers, { api: api as never }));
    const el = mounted.el;
    expect(el.textContent).toContain('u-9');
    await click(button(el, '解除拉黑'));
    await click(button(el, '确认解除'));
    expect(calls.some((c) => c.path.endsWith('/unblock'))).toBe(false);
    expect(el.textContent).toContain('请填写解除原因');
    await type(el.querySelector('input[name="unblock-reason"]'), '误拉黑');
    await click(button(el, '确认解除'));
    expect(calls.find((c) => c.path.endsWith('/unblock'))?.body).toEqual({ reason: '误拉黑' });
    expect(el.textContent).toContain('没有被拉黑的用户');
  });

  it('P2-47 正好 200 行（服务端上限）→ 标题说"最多显示 200 条"，不暗示总数', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `u-${i}`,
      blocked_at: '2026-10-06T03:00:00Z',
      order_count: 1,
    }));
    mounted = await mount(createElement(BlockedUsers, { api: (async () => ({ items })) as never }));
    expect(mounted.el.textContent).toContain('最多显示 200 条');
  });
});
