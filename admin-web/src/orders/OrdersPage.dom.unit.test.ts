// @vitest-environment jsdom
/**
 * 职责：订单列表页的**组件行为**用例——"我要再看一眼最新的"这个动作必须真的发一次请求（ADM3-09）。
 *
 * @why 客服最常做的事是"客户说刚付了款，我刷新看看"。而列表的 `load` 只随
 *      `page / status / applied` 变化：用同一个关键词再点一次"搜索"，这三项一项都不变，
 *      effect 不触发、列表不动，页面却没有任何提示。客服据此回复"还没收到款"——
 *      错的不是数据，是他看到的那一屏没被更新过。
 *      这是纯函数层全绿也照样发生的缺陷：逻辑没错，错的是"哪些变化该触发重载"这个接线。
 *
 * @see ./OrdersPage.tsx；./api.ts；../testing/dom.ts
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { OrdersPage } from './OrdersPage.js';

interface Call {
  path: string;
  method?: string;
}

let mounted: Mounted | undefined;
let calls: Call[];

async function open(): Promise<HTMLElement> {
  calls = [];
  const api = async (req: Call): Promise<unknown> => {
    calls.push(req);
    return { items: [], total: 0 };
  };
  mounted = await mount(createElement(OrdersPage, { api: api as never }));
  return mounted.el;
}

const gets = (): Call[] =>
  calls.filter((c) => c.method !== 'POST' && c.path.includes('/admin/orders'));
const keywordInput = (el: HTMLElement): HTMLInputElement =>
  el.querySelector('input[placeholder^="单号"]') as HTMLInputElement;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('订单列表：刷新入口（ADM3-09）', () => {
  it('挂载时拉一次列表', async () => {
    await open();
    expect(gets()).toHaveLength(1);
  });

  it('🔴 关键词**不变**时连点两次"搜索" → 每次都重新请求（现状：一次都不发）', async () => {
    const el = await open();
    expect(gets()).toHaveLength(1);
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(2);
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(3);
  });

  it('🔴 关键词变了再点"搜索"：仍然只加一次请求，且带上新关键词', async () => {
    const el = await open();
    await type(keywordInput(el), 'W-2601');
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(2);
    expect(gets()[1]?.path).toContain('keyword=W-2601');
    // 关键词已生效后再点一次（不变）→ 仍然重载
    await click(button(el, '搜索'));
    expect(gets()).toHaveLength(3);
  });

  it('🔴 "刷新"按钮：不依赖关键词或页码，点一次就重载一次', async () => {
    const el = await open();
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(2);
    await click(button(el, '刷新'));
    expect(gets()).toHaveLength(3);
  });
});
