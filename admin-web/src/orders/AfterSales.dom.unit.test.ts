// @vitest-environment jsdom
/**
 * 订单详情 · 售后申请面板（AJ-420）。
 *
 * @why 挂整个 OrderDetail：要证明的是"详情页把服务端的 after_sales 交给了面板、点按钮发的是对的请求"，
 *      只挂面板时详情页没接线也是绿的（与客户卡片测试同口径）。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { mount, type Mounted } from '../testing/dom.js';
import { OrderDetail } from './OrderDetail.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const OPEN = {
  id: 'as-1',
  reason: 'damaged',
  description: '外箱压扁，抹茶罐凹了一块',
  status: 'open',
  created_at: '2026-10-08T03:00:00.000Z',
  updated_at: '2026-10-08T03:00:00.000Z',
};

async function open(afterSales: unknown[] | undefined) {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    calls.push(req);
    if (req.path.endsWith('/notes')) return { items: [] };
    if (req.path.endsWith('/resolve')) return { after_sale: { ...OPEN, status: 'processing' } };
    return {
      order_id: 'o-a1',
      order_no: '261008-K7Q2MN',
      status: 'delivered',
      total_jpy: 8930,
      user_id: 'u-cust-a',
      has_dispute: false,
      items: [],
      events: [],
      ...(afterSales === undefined ? {} : { after_sales: afterSales }),
    };
  };
  mounted = await mount(
    createElement(OrderDetail, {
      api: api as never,
      id: 'o-a1',
      source: null,
      onBack: () => undefined,
      onChanged: () => undefined,
    }),
  );
  return { el: mounted.el, calls };
}

const button = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text);

describe('订单详情 · 售后申请', () => {
  it('没有申请（含旧服务端没有该键）：整块不渲染', async () => {
    for (const v of [[], undefined]) {
      const { el } = await open(v);
      expect(el.querySelector('[aria-label="售后申请"]')).toBeNull();
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('进行中的申请：中文原因 / 状态 + 买家原话；结案按钮在没写说明时禁用', async () => {
    const { el } = await open([OPEN]);
    const panel = el.querySelector('[aria-label="售后申请"]');
    expect(panel?.textContent).toContain('商品破损');
    expect(panel?.textContent).toContain('已提交，等待处理');
    expect(panel?.textContent).toContain('外箱压扁，抹茶罐凹了一块');
    expect(button(el, '已处理，结案')?.disabled).toBe(true);
    expect(button(el, '不予处理，结案')?.disabled).toBe(true);
    expect(button(el, '标记处理中')?.disabled).toBe(false);
  });

  it('点"标记处理中"：发 resolve {status: processing}，不带 note；之后刷新详情', async () => {
    const { el, calls } = await open([OPEN]);
    const before = calls.filter((c) => c.path === '/api/v1/admin/orders/o-a1').length;
    await act(async () => {
      button(el, '标记处理中')?.click();
      await Promise.resolve();
    });
    const post = calls.find((c) => c.path.endsWith('/resolve'));
    expect(post).toMatchObject({
      path: '/api/v1/admin/orders/o-a1/after-sales/as-1/resolve',
      method: 'POST',
    });
    // 精确比对请求体：toMatchObject 是子集匹配，多带一个 note: '' 也会绿（注回实测过）
    expect(post?.body).toEqual({ status: 'processing' });
    expect(calls.filter((c) => c.path === '/api/v1/admin/orders/o-a1').length).toBe(before + 1);
  });

  it('结案的申请：只读显示处理说明，没有任何按钮', async () => {
    const { el } = await open([
      { ...OPEN, status: 'rejected', resolution_note: '照片显示外箱完好', handled_by: 'admin:u-1' },
    ]);
    const panel = el.querySelector('[aria-label="售后申请"]');
    expect(panel?.textContent).toContain('处理说明：照片显示外箱完好（admin:u-1）');
    expect(panel?.querySelectorAll('button')).toHaveLength(0);
  });
});
