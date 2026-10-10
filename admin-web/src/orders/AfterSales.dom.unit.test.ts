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
import { click, mount, type, type Mounted } from '../testing/dom.js';
import { UnsavedProvider } from '../ui/unsaved.js';
import { AFTER_SALE_DESCRIPTION_MAX } from '@waselect/shared';
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

async function open(
  afterSales: unknown[] | undefined,
  wrap: (el: ReturnType<typeof createElement>) => ReturnType<typeof createElement> = (el) => el,
) {
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
    wrap(
      createElement(OrderDetail, {
        api: api as never,
        id: 'o-a1',
        source: null,
        onBack: () => undefined,
        onChanged: () => undefined,
      }),
    ),
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

// 统一结论 5.4：结案后买家立刻看到说明、且不能撤回——原先点了即提交；说明草稿也不进"未保存离开提醒"
describe('订单详情 · 售后结案的二次确认与草稿保护', () => {
  const note = (el: HTMLElement): HTMLTextAreaElement | null =>
    el.querySelector('[aria-label="售后申请"] textarea');

  it('🔴 写好说明点「已处理，结案」→ 先弹确认、不发请求；点「确认结案」才提交，请求体带说明', async () => {
    const { el, calls } = await open([OPEN]);
    await type(note(el), '已安排部分退款 1,500 円');
    await click(button(el, '已处理，结案') ?? null);
    expect(calls.filter((c) => c.path.endsWith('/resolve'))).toHaveLength(0);
    expect(el.textContent).toContain('买家会在订单详情里看到');
    await click(button(el, '确认结案') ?? null);
    const post = calls.find((c) => c.path.endsWith('/resolve'));
    expect(post?.body).toEqual({ status: 'resolved', note: '已安排部分退款 1,500 円' });
  });

  it('🔴 确认框里点「取消」→ 不提交，说明还在', async () => {
    const { el, calls } = await open([OPEN]);
    await type(note(el), '照片显示外箱完好');
    await click(button(el, '不予处理，结案') ?? null);
    await click(button(el, '取消') ?? null);
    expect(calls.filter((c) => c.path.endsWith('/resolve'))).toHaveLength(0);
    expect(note(el)?.value).toBe('照片显示外箱完好');
  });

  it('🔴 说明框里有字 → 登记为"有未保存的修改"（离开页面会先问）', async () => {
    const marks: Array<[string, boolean]> = [];
    const { el } = await open([OPEN], (child) =>
      createElement(
        UnsavedProvider,
        { dirty: false, markDirty: (k: string, d: boolean) => marks.push([k, d]) },
        child,
      ),
    );
    await type(note(el), '处理中');
    expect(marks.some(([, d]) => d)).toBe(true);
  });

  // 统一结论 5.4：浏览器 maxLength 按 UTF-16 码元数（实测 Chrome 152：maxLength=2 只容得下 1 个 😀），
  // 服务端与页面提示按字数——500 个 emoji 合法却会被浏览器挡在 250 个。上限放到 2 倍，真正的 500 字由提示与禁用按钮把关
  it('🔴 说明框的浏览器上限不挡合法输入：maxLength = 上限 × 2（500 个 emoji 也能输入）', async () => {
    const { el } = await open([OPEN]);
    expect(note(el)?.maxLength).toBe(AFTER_SALE_DESCRIPTION_MAX * 2);
  });
});
