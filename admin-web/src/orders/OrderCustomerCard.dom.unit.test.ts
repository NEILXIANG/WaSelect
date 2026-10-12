// @vitest-environment jsdom
/**
 * 职责：订单详情右栏的**客户卡片**（AJ-404；对标分析 §4.2 第 168 行）——历史单数、累计付款（不扣退款）、是否拉黑、进客户页的链接。
 *
 * @why 挂整个 `OrderDetail` 而不是只挂卡片组件：要证明的是"详情页真的把服务端的 `customer` 交给了卡片"，
 *      卡片自己渲染对了而详情页没接线，单测全绿、页面上什么都没有。
 * @why 老服务端（没有 `customer` 键）时卡片退回"只有链接"：前后端不同步发布时，详情页不该因为少一个键而缺一块。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../testing/dom.js';
import { OrderDetail } from './OrderDetail.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(extra: Record<string, unknown>): Promise<HTMLElement> {
  const api = async (req: { path: string }): Promise<unknown> => {
    if (req.path.endsWith('/notes')) return { items: [] };
    return {
      order_id: 'o-a1',
      order_no: '260901-K7Q2MN',
      status: 'paid',
      total_jpy: 8930,
      user_id: 'u-cust-a',
      has_dispute: false,
      items: [],
      events: [],
      ...extra,
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
  return mounted.el;
}

function customerField(el: HTMLElement): Element | undefined {
  return [...el.querySelectorAll('.field')].find(
    (f) => (f.querySelector('.label')?.textContent ?? '') === '客户',
  );
}

describe('订单详情 · 客户卡片', () => {
  it('单数 + 累计付款 + 链到客户页', async () => {
    const el = await open({
      customer: { user_id: 'u-cust-a', order_count: 3, paid_total_jpy: 21380, blocked: false },
    });
    const f = customerField(el);
    expect(f?.textContent).toContain('历史 3 单 · 累计付款 21,380 日元'); // 走查 2026-10-08：与客户页同一说法
    expect(f?.textContent).not.toContain('已拉黑');
    expect(f?.querySelector('a')?.getAttribute('href')).toBe('#/customers/u-cust-a');
  });

  it('已拉黑的客户：卡片里标红', async () => {
    const el = await open({
      customer: { user_id: 'u-cust-a', order_count: 1, paid_total_jpy: 4980, blocked: true },
    });
    const f = customerField(el);
    expect(f?.querySelector('.error')?.textContent).toBe('已拉黑');
  });

  it('服务端没给 customer（旧版本）：仍按 user_id 给链接，不显示统计', async () => {
    const el = await open({});
    const f = customerField(el);
    expect(f?.querySelector('a')?.getAttribute('href')).toBe('#/customers/u-cust-a');
    expect(f?.textContent).not.toContain('累计');
  });
});
