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
    // 第一批①：三道口子依次为「解除拉黑」（入口）→「去确认」（填完原因）→「确认解除」（弹层）
    await click(button(el, '解除拉黑'));
    await click(button(el, '去确认'));
    expect(calls.some((c) => c.path.endsWith('/unblock'))).toBe(false);
    expect(el.textContent).toContain('请填写解除原因');
    await type(el.querySelector('input[name="unblock-reason"]'), '误拉黑');
    await click(button(el, '去确认'));
    await click(button(el, '确认解除'));
    expect(calls.find((c) => c.path.endsWith('/unblock'))?.body).toEqual({ reason: '误拉黑' });
    expect(el.textContent).toContain('没有被拉黑的用户');
  });

  // 全入口点击测试 2026-10-12：解除表单 / 确认弹层 / 成功提示都写"解除 <36 位 id>"；表格没有表头，"3 单"与时间不知道是什么
  it('🔴 解除拉黑的表单、确认弹层、成功提示都写客户称呼，不写内部 id；表格有表头', async () => {
    const id = '3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718';
    let blocked = true;
    const api = async (req: { path: string }): Promise<unknown> => {
      if (req.path.endsWith('/unblock')) {
        blocked = false;
        return { already_unblocked: false };
      }
      return {
        items: blocked
          ? [
              {
                id,
                blocked_at: '2026-10-06T03:00:00Z',
                order_count: 3,
                last_recipient: 'Karen Wong',
                last_contact_email: 'karen.wong@comcast.net',
              },
            ]
          : [],
      };
    };
    mounted = await mount(createElement(BlockedUsers, { api: api as never }));
    const el = mounted.el;
    expect([...el.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual([
      '客户',
      '拉黑时间（日本时间）',
      '订单数',
      '操作',
    ]);
    await click(button(el, '解除拉黑'));
    expect(el.textContent).toContain('解除 Karen Wong · karen.wong@comcast.net 的拉黑');
    await type(el.querySelector('input[name="unblock-reason"]'), '误拉黑');
    await click(button(el, '去确认'));
    expect(el.querySelector('.dialog')?.textContent).toContain('Karen Wong');
    expect(el.textContent).not.toContain(id);
    await click(button(el, '确认解除'));
    expect(el.textContent).toContain('已解除 Karen Wong · karen.wong@comcast.net 的拉黑');
    expect(el.textContent).not.toContain(id);
  });

  // 三端模拟测试 2026-10-11（用户要求：运营看不懂的 id 不进正文）：有收件人 / 邮箱就不再拼 36 位 id；都没有时显示缩短的 id
  it('🔴 有收件人的行不显示客户 id；没有收件人时显示缩短 id（悬停看全文）', async () => {
    const api = async (): Promise<unknown> => ({
      items: [
        {
          id: 'u-2bc71278-6054-4cad-8527-e6582d252a9d',
          blocked_at: '2026-10-06T03:00:00Z',
          order_count: 3,
          last_recipient: 'Karen Wong',
          last_contact_email: 'k@example.com',
        },
        {
          id: 'u-5e526b79-91ca-42e2-96a7-41363673a061',
          blocked_at: '2026-10-06T03:00:00Z',
          order_count: 0,
        },
      ],
    });
    mounted = await mount(createElement(BlockedUsers, { api: api as never }));
    const rows = [...mounted.el.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('Karen Wong');
    expect(rows[0]).not.toContain('u-2bc71278');
    expect(rows[1]).toContain('u-5e526b79…');
    expect(rows[1]).not.toContain('91ca-42e2');
  });

  it('AJ-404：每行带「客户详情」链接（拉黑 / 解除的主入口已挪到客户页，风控页保留）', async () => {
    const items = [{ id: 'u-9', blocked_at: '2026-10-06T03:00:00Z', order_count: 2 }];
    mounted = await mount(createElement(BlockedUsers, { api: (async () => ({ items })) as never }));
    const a = [...mounted.el.querySelectorAll('a')].find((x) => x.textContent === '客户详情');
    expect(a?.getAttribute('href')).toBe('#/customers/u-9');
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

describe('共用父页的 Toast 出口（审查 2026-10-09 #7）', () => {
  it('🔴 传入 sink 时不自渲染 .toast-stack，提示走父页的 sink', async () => {
    const errors: string[] = [];
    const sink = {
      toasts: [],
      success: () => undefined,
      info: () => undefined,
      error: (t: string) => {
        errors.push(t);
      },
      dismiss: () => undefined,
    };
    const api = async (): Promise<unknown> => ({
      items: [{ id: 'u-9', blocked_at: '2026-10-06T03:00:00Z', order_count: 2 }],
    });
    mounted = await mount(createElement(BlockedUsers, { api: api as never, sink }));
    const el = mounted.el;
    await click(button(el, '解除拉黑'));
    await click(button(el, '去确认'));
    expect(errors).toEqual(['请填写解除原因（会记录下来）']);
    expect(el.querySelector('.toast-stack')).toBeNull();
  });
});
