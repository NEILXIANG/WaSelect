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
    // 三端模拟测试 2026-10-11（用户截图）：异常看板——一类一行、说清谁处理、给「去处理」入口
    const row = [...el.querySelectorAll('.recon-table tbody tr')].map((r) => r.textContent ?? '');
    expect(row).toHaveLength(1);
    expect(row[0]).toContain('退款滞留超过 24 小时');
    expect(row[0]).toContain('运营');
    const go = [...el.querySelectorAll('.recon-table a')].find((a) =>
      a.textContent?.includes('去处理'),
    );
    expect(go?.getAttribute('href')).toBe('#/orders?status=refunding');
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

describe('运营日志：按日期范围查（评估 P2，2026-10-09）', () => {
  it('🔴 选了开始 / 结束日期点查询 → 请求带 created_from / created_to（日本时间日历日）', async () => {
    const el = await open();
    const set = async (label: string, v: string) => {
      await type(el.querySelector(`input[aria-label="${label}"]`), v);
    };
    await set('开始日期（日本时间）', '2026-10-02');
    await set('结束日期（日本时间）', '2026-10-03');
    await click(button(el, '查询'));
    const last = paths.filter((p) => p.includes('/admin/audit')).at(-1) ?? '';
    expect(last).toContain('created_from=2026-10-02');
    expect(last).toContain('created_to=2026-10-03');
  });

  it('🔴 开始晚于结束 → 不发请求，提示"开始日期不能晚于结束日期"', async () => {
    const el = await open();
    await type(el.querySelector('input[aria-label="开始日期（日本时间）"]'), '2026-10-05');
    await type(el.querySelector('input[aria-label="结束日期（日本时间）"]'), '2026-10-01');
    const before = paths.length;
    await click(button(el, '查询'));
    expect(paths.length).toBe(before);
    expect(el.querySelector('.toast[data-kind="error"]')?.textContent).toContain(
      '开始日期不能晚于结束日期',
    );
  });
});
