/**
 * 职责：网址路由的**解析与回写**用例（第一批②）。
 *
 * @why 纯函数层先把"地址栏 → {页 / id / 筛选}"这件事钉死：
 *      页面那一层（App.tsx / OrdersPage）测的是"切过去对不对"，
 *      而"地址栏里的这串字符到底被读成什么"必须单独有一张边界表——
 *      运营会**手改和粘贴**地址栏，粘贴错一个字的后果由这一层决定。
 *
 * @limitation `navigate` / `subscribe` 要碰 `location`，由 `App.dom.unit.test.ts`（jsdom）覆盖。
 * @see ./router.ts
 */
import { describe, expect, it } from 'vitest';
import {
  buildHash,
  HOME_PAGE,
  isPage,
  parseHash,
  PAGES,
  queryParam,
  type Route,
} from './router.js';

describe('parseHash：放行侧（正常能认出来的地址）', () => {
  const cases: Array<{ hash: string; want: Route }> = [
    { hash: '#/orders', want: { page: 'orders', id: '', query: new URLSearchParams() } },
    { hash: '/orders', want: { page: 'orders', id: '', query: new URLSearchParams() } },
    { hash: '#/orders/o-1', want: { page: 'orders', id: 'o-1', query: new URLSearchParams() } },
    {
      hash: '#/orders?status=paid',
      want: { page: 'orders', id: '', query: new URLSearchParams('status=paid') },
    },
    {
      hash: '#/orders/o-1?status=paid&q=abc',
      want: { page: 'orders', id: 'o-1', query: new URLSearchParams('status=paid&q=abc') },
    },
    { hash: '#/products', want: { page: 'products', id: '', query: new URLSearchParams() } },
    // 尾斜杠宽容：运营从别处复制来的地址常常多一个 `/`，那不是错误
    { hash: '#/orders/', want: { page: 'orders', id: '', query: new URLSearchParams() } },
  ];

  it.each(cases)('$hash → $want.page', ({ hash, want }) => {
    const got = parseHash(hash);
    expect(got.page).toBe(want.page);
    expect(got.id).toBe(want.id);
    expect(got.query.toString()).toBe(want.query.toString());
  });

  it('id 里的 URL 转义会被还原（内部 id 含 `-`，但将来换成别的形式也不该被吃掉）', () => {
    expect(parseHash('#/orders/a%2Fb').id).toBe('a/b');
    expect(parseHash('#/orders/%E6%97%A5%E6%9C%AC').id).toBe('日本');
  });
});

describe('parseHash：拒绝侧（认不出的一律回落首页，不白屏）', () => {
  // ⚠️ 刻**不**含 `#/orders/`——尾斜杠是放行侧（见上一组）
  const bad = ['', '#', '#foo', '#/', '#/nope', '#/Orders', '?status=paid'];

  it.each(bad)('%s → 首页', (hash) => {
    const got = parseHash(hash);
    expect(got.page).toBe(HOME_PAGE);
    expect(got.id).toBe('');
    expect(got.query.toString()).toBe('');
  });

  it('认不出的页**不带**它后面的 id（不把 nope/xxx 读成"nope 页的 xxx"）', () => {
    expect(parseHash('#/nope/o-1')).toEqual({
      page: HOME_PAGE,
      id: '',
      query: new URLSearchParams(),
    });
  });
});

describe('buildHash ↔ parseHash 往返', () => {
  const routes: Route[] = [
    { page: 'dashboard', id: '', query: new URLSearchParams() },
    { page: 'orders', id: 'o-1', query: new URLSearchParams('status=paid') },
    { page: 'orders', id: '', query: new URLSearchParams('status=shipped&q=田中') },
    { page: 'products', id: '', query: new URLSearchParams() },
  ];

  it.each(routes)('$page/$id 往返不变', (route) => {
    const back = parseHash(buildHash(route));
    expect(back.page).toBe(route.page);
    expect(back.id).toBe(route.id);
    expect(back.query.toString()).toBe(route.query.toString());
  });

  it('没有查询参数时不留一个空问号（地址栏里 `?` 后面空白像坏了）', () => {
    expect(buildHash({ page: 'orders', id: '', query: new URLSearchParams() })).toBe('#/orders');
  });
});

describe('页面枚举与查询参数读取', () => {
  it('isPage 认得全部一级页，且不认首页之外的任意串', () => {
    for (const p of PAGES) expect(isPage(p)).toBe(true);
    expect(isPage('nope')).toBe(false);
    expect(isPage('ORDERS')).toBe(false);
    expect(isPage('')).toBe(false);
  });

  it('queryParam：没给与给了空串都按"没有"（页面里不该分出第三种状态）', () => {
    expect(queryParam(new URLSearchParams(''), 'status')).toBe('');
    expect(queryParam(new URLSearchParams('status='), 'status')).toBe('');
    expect(queryParam(new URLSearchParams('status=paid'), 'status')).toBe('paid');
  });
});
