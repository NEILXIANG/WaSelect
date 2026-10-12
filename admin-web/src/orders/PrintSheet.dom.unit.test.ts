// @vitest-environment jsdom
/**
 * 职责：打印页在 React StrictMode 下也能取完数据（全入口点击测试 2026-10-11）。
 * @why 实测：开发环境点「打印拣货单与面单信息」，两单详情都 200 了，页面却永远停在"加载中…"。
 *      StrictMode 会"挂载 → 卸载 → 再挂载"，卸载那次把 live 置 false、再挂载没有置回 true，
 *      取数回来被 `if (!live.current) return` 吞掉。生产不双挂载所以没暴露，但任何重新挂载都会撞上。
 */
import { StrictMode, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, mount, type Mounted } from '../testing/dom.js';
import { PrintSheet } from './PrintSheet.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('PrintSheet', () => {
  it('🔴 StrictMode 下取数回来后不再停在"加载中…"', async () => {
    const order = {
      order_id: 'o-1',
      order_no: '261012-ABCDEF',
      status: 'paid',
      items: [],
      address: {
        recipient: 'Ken Tanaka',
        line1: '1 Main St',
        city: 'Seattle',
        state: 'WA',
        postal_code: '98101',
      },
    };
    mounted = await mount(
      createElement(
        StrictMode,
        null,
        createElement(PrintSheet, {
          api: (async () => order) as never,
          ids: ['o-1'],
          onBack: () => undefined,
          onError: () => undefined,
        }),
      ),
    );
    await flush();
    expect(mounted.el.textContent).not.toContain('加载中…');
  });
});
