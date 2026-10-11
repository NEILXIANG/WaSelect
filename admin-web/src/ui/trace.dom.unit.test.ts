// @vitest-environment jsdom
/**
 * 职责：求助编号这一行的显示（ui/trace.tsx）。
 * @why 三端模拟测试 2026-10-11（用户截图指出）：「如需求助，把这串编号发给技术人员：74a456b8-49a0-484b-a6c2-b70948b681e4」
 *      ——36 位一长串，念不出、抄易错。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, mount, type Mounted } from '../testing/dom.js';
import { TraceLine } from './trace.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

const FULL = '74a456b8-49a0-484b-a6c2-b70948b681e4';

describe('TraceLine', () => {
  it('🔴 36 位编号只显示前 8 位（服务端日志按前缀能查），悬停看全文；「复制」复制的是完整编号', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    mounted = await mount(createElement(TraceLine, { traceId: FULL }));
    const line = mounted.el.querySelector('.trace-line');
    expect(line?.textContent).toContain('74a456b8');
    expect(line?.textContent).not.toContain('49a0-484b');
    expect(line?.querySelector('.selectable')?.getAttribute('title')).toBe(FULL);
    await click([...mounted.el.querySelectorAll('button')].find((b) => b.textContent === '复制'));
    expect(writeText).toHaveBeenCalledWith(FULL);
    expect(mounted.el.textContent).toContain('已复制');
  });

  it('复制失败（非 HTTPS / 权限）→ 改为显示完整编号，提示手动选中', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
    });
    mounted = await mount(createElement(TraceLine, { traceId: FULL }));
    await click([...mounted.el.querySelectorAll('button')].find((b) => b.textContent === '复制'));
    expect(mounted.el.textContent).toContain(FULL);
    expect(mounted.el.textContent).toContain('手动');
  });

  it('短编号原样显示，不给复制按钮（本来就念得出）', async () => {
    mounted = await mount(createElement(TraceLine, { traceId: 'tr-42' }));
    expect(mounted.el.querySelector('.selectable')?.textContent).toBe('tr-42');
    expect(mounted.el.querySelector('button')).toBeNull();
  });
});
