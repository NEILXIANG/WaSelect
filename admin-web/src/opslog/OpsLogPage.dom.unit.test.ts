// @vitest-environment jsdom
/** 职责：运营日志页交互（剩余清单 3-2）——对账摘要、审计列表、过滤与翻页发出的请求。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OpsLogPage } from './OpsLogPage.js';

let mounted: Mounted | undefined;
const paths: string[] = [];

async function open(total = 120): Promise<HTMLElement> {
  paths.length = 0;
  const api = (req: { path: string }): Promise<unknown> => {
    paths.push(req.path);
    if (req.path.includes('/reconciliation/latest')) {
      return Promise.resolve({
        run: {
          ran_at: '2026-10-05T18:00:00.000Z',
          counts: { stuck_refunds: 1 },
          samples: { stuck_refunds: ['o-9'] },
        },
      });
    }
    return Promise.resolve({
      total,
      items: [
        {
          id: 1,
          actor: 'admin:u-a',
          action: 'PUT /api/v1/admin/products/:id',
          target: 'p-1',
          status_code: 409,
          created_at: '2026-10-05T00:00:00.000Z',
        },
      ],
    });
  };
  mounted = await mount(createElement(OpsLogPage, { api: api as never }));
  return mounted.el;
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('运营日志页（3-2）', () => {
  it('🔴 进页即显示对账异常摘要与审计第一页', async () => {
    const el = await open();
    expect(el.textContent).toContain('发现 1 类异常');
    expect(el.textContent).toContain('o-9');
    expect(el.textContent).toContain('PUT /api/v1/admin/products/:id');
    expect(el.textContent).toContain('第 1 / 3 页，共 120 条');
    expect(paths.some((p) => p.startsWith('/api/v1/admin/audit?page=1&size=50'))).toBe(true);
  });

  it('填操作人点查询 → 带 actor 参数、回到第 1 页；下一页 → page=2', async () => {
    const el = await open();
    const input = el.querySelector('input[aria-label="操作人"]') as HTMLInputElement;
    await type(input, 'admin:u-a');
    await click(button(el, '查询'));
    expect(paths.at(-1)).toContain('actor=admin%3Au-a');
    await click(button(el, '下一页'));
    expect(paths.at(-1)).toContain('page=2');
  });
});
