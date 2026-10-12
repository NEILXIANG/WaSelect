// @vitest-environment jsdom
/** 订单页「待处理」那一排带计数（第三轮走查 2026-10-12）。 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
import { AttentionLinks } from './AttentionLinks.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('AttentionLinks', () => {
  it('🔴 每一类写上单数；0 单收淡；取数失败写 —；点一类回调它', async () => {
    const totals: Record<string, number> = { ship_overdue: 7, after_sale: 30, late_paid: 0 };
    const picked: string[] = [];
    mounted = await mount(
      createElement(AttentionLinks, {
        api: (async (req: { path: string }) => {
          const a = new URLSearchParams(req.path.split('?')[1]).get('attention') ?? '';
          if (!(a in totals)) throw new Error('boom');
          return { items: [], total: totals[a] };
        }) as never,
        onPick: (a: string) => picked.push(a),
      }),
    );
    await flush();
    const el = mounted.el;
    expect(button(el, '超时未发货 7')).not.toBeNull();
    expect(button(el, '售后待处理 30')).not.toBeNull();
    const zero = button(el, '迟到付款待退 0');
    expect(zero?.className).toContain('muted');
    expect(button(el, '拒付待处理 —')).not.toBeNull();
    await click(button(el, '售后待处理 30'));
    expect(picked).toEqual(['after_sale']);
  });
});

// 三天提交复查 2026-10-12：计数只带 attention，点进去的列表却保留了当前的状态 / 关键词 / 日期 / 买家筛选——
//   "售后待处理 3"点进去只有 1 单
describe('AttentionLinks：计数带上当前筛选', () => {
  it('🔴 计数请求带上传入的关键词与状态', async () => {
    const paths: string[] = [];
    mounted = await mount(
      createElement(AttentionLinks, {
        api: (async (req: { path: string }) => {
          paths.push(req.path);
          return { items: [], total: 0 };
        }) as never,
        base: { keyword: 'Ken', status: ['paid'] },
        onPick: () => undefined,
      }),
    );
    await flush();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toContain('keyword=Ken');
      expect(p).toContain('status=paid');
    }
  });
});
