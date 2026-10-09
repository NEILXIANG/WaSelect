// @vitest-environment jsdom
/**
 * 页面级错误边界（AJ-421）：坏的只是这一页、边界外（侧栏）照常；上报一次带页名与组件栈；换页即复位。
 *
 * @why 用一个宿主组件把"侧栏按钮"放在边界外：要证明的正是"边界外不受影响、还能点着去别处"。
 */
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button, click, mount, type Mounted } from '../testing/dom.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import type { ClientErrorReport } from './error-report.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function Thrower({ crash }: { crash: boolean }) {
  if (crash) throw new TypeError("Cannot read properties of undefined (reading 'items')");
  return createElement('p', null, '页面内容');
}

function Host({ reports }: { reports: ClientErrorReport[] }) {
  const [page, setPage] = useState('orders');
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', onClick: () => setPage('dashboard') }, '工作台'),
    createElement(ErrorBoundary, {
      page,
      resetKey: page,
      reporter: {
        report: (r: ClientErrorReport) => {
          reports.push(r);
        },
      },
      children: createElement(Thrower, { crash: page === 'orders' }),
    }),
  );
}

describe('ErrorBoundary', () => {
  it('🔴 页面渲染抛错：只这一块换成说明（不展示英文原文），边界外照常；上报一次带页名与组件栈', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React 开发模式会把接住的错误再打印一次
    const reports: ClientErrorReport[] = [];
    mounted = await mount(createElement(Host, { reports }));
    const alert = mounted.el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('这个页面出错了');
    expect(alert?.textContent).not.toContain('Cannot read properties');
    expect(button(mounted.el, '工作台')).not.toBeNull();
    expect(button(mounted.el, '刷新页面')).not.toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'render', page: 'orders' });
    expect(reports[0]?.message).toContain('Cannot read properties');
    expect(reports[0]?.stack).toContain('component stack');
    expect(reports[0]?.stack).toContain('Thrower');
  });

  it('🔴 换页（resetKey 变化）→ 复位，显示新页内容', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reports: ClientErrorReport[] = [];
    mounted = await mount(createElement(Host, { reports }));
    await click(button(mounted.el, '工作台'));
    expect(mounted.el.querySelector('[role="alert"]')).toBeNull();
    expect(mounted.el.textContent).toContain('页面内容');
    expect(mounted.el.querySelector('.page-boundary')?.getAttribute('data-page')).toBe('dashboard');
  });
});
