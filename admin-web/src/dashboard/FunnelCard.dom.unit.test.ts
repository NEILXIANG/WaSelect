// @vitest-environment jsdom
/**
 * 职责：工作台转化漏斗卡片（第 25 项，AJ-438）。
 * @why 走组件用例：要证明"切档位真的换了请求参数""失败不拖垮整个工作台"，纯函数里没有这两件事。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
import { FunnelCard } from './FunnelCard.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const RESP = (days: number, n: number[]) => ({
  generated_at: '2026-10-10T03:00:00.000Z',
  days,
  from: '2026-10-03T15:00:00.000Z',
  to: '2026-10-10T15:00:00.000Z',
  steps: ['visit', 'view_item', 'intent', 'checkout', 'pay_start', 'paid'].map((key, i) => ({
    key,
    visitors: n[i],
  })),
});

describe('FunnelCard', () => {
  it('🔴 默认近 7 天：六行人数与"比上一步"；点「今天」→ 以 days=1 重取', async () => {
    const paths: string[] = [];
    mounted = await mount(
      createElement(FunnelCard, {
        api: (async (req: { path: string }) => {
          paths.push(req.path);
          return req.path.endsWith('days=1')
            ? RESP(1, [5, 3, 1, 1, 1, 0])
            : RESP(7, [200, 120, 60, 45, 30, 24]);
        }) as never,
      }),
    );
    await flush();
    const el = mounted.el;
    // 挂载取近 7 天（测试宿主开 StrictMode，开发模式挂载 effect 双跑，按动作前后的增量数——testing/dom.ts）
    expect(new Set(paths)).toEqual(new Set(['/api/v1/admin/dashboard/funnel?days=7']));
    const before = paths.length;
    expect(el.textContent).toContain('进店（看过任意页面）');
    expect(el.textContent).toContain('200 人');
    expect(el.textContent).toContain('付款成功');
    expect(el.textContent).toContain('比上一步 80%');
    await click(button(el, '今天'));
    await flush();
    expect(paths).toHaveLength(before + 1);
    expect(paths.at(-1)).toBe('/api/v1/admin/dashboard/funnel?days=1');
    expect(el.textContent).toContain('5 人');
  });

  it('取数失败 → 卡片里说取不到、给「重试」，不抛到整页', async () => {
    let fail = true;
    mounted = await mount(
      createElement(FunnelCard, {
        api: (async () => {
          if (fail) throw new ApiError(50000, '服务器内部错误', 'tr-f');
          return RESP(7, [1, 1, 1, 1, 1, 1]);
        }) as never,
      }),
    );
    await flush();
    const el = mounted.el;
    expect(el.textContent).toContain('漏斗数据暂时取不到');
    fail = false;
    await click(button(el, '重试'));
    await flush();
    expect(el.textContent).toContain('1 人');
  });
});
