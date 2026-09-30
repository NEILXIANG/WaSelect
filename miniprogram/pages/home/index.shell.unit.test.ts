/**
 * 职责：首页薄壳的**行为**用例——把 `Page({...})` 真的跑起来，编排响应先后，看 `data` 最终是什么（R-04 / AJ-226）。
 *
 * @why `index.vm.unit.test.ts` 里"防复发"那组是数源码字符串（`nextSeq(this.seq)` 出现几次）。
 *      它全绿的同时，首页有三个真实缺陷：
 *        ① `reload` 与 `loadMore` 共用一个序号槽：切分类的请求在途时触底，`loadMore` 领走新号
 *           ⇒ 切分类的响应被判过期丢弃、`loading` 永不清；而 `loadMore` 用**新分类 + 旧页码**
 *           取回的第 N+1 页被追加到**旧分类**的列表后面；
 *        ② 过期的 `loadMore` 只清实例标志、不清 `data.loadingMore` ⇒ 底部"加载中…"卡住；
 *        ③ 搜索框里**打了字但没提交**就触底，`loadMore` 读的是输入框里的新词
 *           ⇒ 旧列表后面接上了新关键词的第 2 页。
 *      三条都是"哪个响应先回来"的问题，只有编排时序才测得出来。
 *
 * @see ../../../test/helpers/mp-page.ts（宿主与其 @limitation）；./index.js
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

interface Call {
  data: { page: number; category?: string; keyword?: string };
  d: ReturnType<typeof deferred<unknown>>;
}

let calls: Call[];
let page: LoadedPage;

/** 一页商品：id 带上分类与页码，列表里混了别的分类一眼能看出来。 */
function listOf(tag: string, pageNo: number, total = 40) {
  return {
    total,
    items: Array.from({ length: 20 }, (_, i) => ({
      id: `${tag}-p${String(pageNo)}-${String(i)}`,
      name_ja: `${tag} ${String(i)}`,
      price_jpy: 1000,
      image_url: '',
      in_stock: true,
    })),
  };
}

const ids = (): string[] => (page.data['cards'] as Array<{ id: string }>).map((c) => c.id);
const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const tapCategory = (key: string): void =>
  call('onCategoryTap', { currentTarget: { dataset: { key } } });
/** 让已兑现的 promise 链跑完（薄壳里是 await → setData → finally）。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  calls = [];
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      cart: { count: () => 0 },
      api: (req: { data: Call['data'] }) => {
        const d = deferred<unknown>();
        calls.push({ data: req.data, d });
        return d.promise;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 进入首页并让第 1 页（全部分类）落地。 */
async function enter(): Promise<void> {
  call('onLoad');
  calls[0]!.d.resolve(listOf('all', 1));
  await settle();
  expect(ids()).toHaveLength(20);
  expect(page.data['hasMore']).toBe(true);
}

describe('首页薄壳：响应先后（R-04 / AJ-226）', () => {
  it('🔴 切分类的请求在途时触底：切分类的结果照常落地，不混进旧分类，loading 不卡', async () => {
    await enter();
    tapCategory('food'); // calls[1]：food 第 1 页，在途
    expect(page.data['loading']).toBe(true);
    call('onReachBottom'); // 此刻列表还是旧的（all），用户滚到了底
    // 切分类在途时**不得**发"下一页"：发了就是"新分类 + 旧页码"
    expect(calls).toHaveLength(2);

    calls[1]!.d.resolve(listOf('food', 1));
    await settle();
    expect(page.data['loading']).toBe(false);
    expect(ids().every((id) => id.startsWith('food-p1-'))).toBe(true);
    expect(ids()).toHaveLength(20);
  });

  it('🔴 "下一页"在途时切分类：迟到的下一页被丢弃，且底部的"加载中"不卡住', async () => {
    await enter();
    call('onReachBottom'); // calls[1]：all 第 2 页，在途
    expect(page.data['loadingMore']).toBe(true);
    tapCategory('food'); // calls[2]：food 第 1 页
    // 切分类那一刻底部的"加载中"就该收起来：它属于上一个列表
    expect(page.data['loadingMore']).toBe(false);

    calls[2]!.d.resolve(listOf('food', 1));
    await settle();
    calls[1]!.d.resolve(listOf('all', 2)); // 旧分类的第 2 页迟到
    await settle();
    expect(ids().every((id) => id.startsWith('food-p1-'))).toBe(true);
    expect(page.data['loadingMore']).toBe(false);

    // 标志位没有卡死：新分类下再触底，能正常发出第 2 页并追加
    call('onReachBottom');
    expect(calls).toHaveLength(4);
    expect(calls[3]!.data).toMatchObject({ page: 2, category: 'food' });
    calls[3]!.d.resolve(listOf('food', 2));
    await settle();
    expect(ids()).toHaveLength(40);
    expect(page.data['loadingMore']).toBe(false);
  });

  it('迟到的旧"下一页"不得清掉新一代"下一页"的在途标志（否则同一页会被发两次）', async () => {
    await enter();
    call('onReachBottom'); // calls[1]：all 第 2 页，在途
    tapCategory('food'); // calls[2]
    calls[2]!.d.resolve(listOf('food', 1));
    await settle();
    call('onReachBottom'); // calls[3]：food 第 2 页，在途
    expect(calls).toHaveLength(4);

    calls[1]!.d.resolve(listOf('all', 2)); // 上一代的"下一页"此刻才回来
    await settle();
    call('onReachBottom'); // food 第 2 页仍在途 → 必须被挡住
    expect(calls).toHaveLength(4);
    expect(page.data['loadingMore']).toBe(true);
  });

  it('🔴 搜索框里打了字但没提交就触底："下一页"沿用**已提交**的关键词', async () => {
    await enter();
    call('onSearchInput', { detail: { value: '抹茶' } }); // 只是输入，没点搜索
    call('onReachBottom');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data.page).toBe(2);
    expect(calls[1]!.data.keyword ?? '').toBe('');

    // 提交搜索之后，"下一页"才带上这个词
    calls[1]!.d.resolve(listOf('all', 2));
    await settle();
    call('onSearch');
    calls[2]!.d.resolve(listOf('matcha', 1));
    await settle();
    call('onReachBottom');
    expect(calls[3]!.data).toMatchObject({ page: 2, keyword: '抹茶' });
  });

  it('连点两个分类、先点的后回来：只有最后一次的结果落地（B36 的原始形态，行为化）', async () => {
    await enter();
    tapCategory('food'); // calls[1]
    tapCategory('kitchen'); // calls[2]
    calls[2]!.d.resolve(listOf('kitchen', 1));
    await settle();
    calls[1]!.d.resolve(listOf('food', 1)); // 旧的后到
    await settle();
    expect(ids().every((id) => id.startsWith('kitchen-p1-'))).toBe(true);
    expect(page.data['loading']).toBe(false);
  });

  it('"下一页"在途时再触底：不重复发同一页（滚动事件会连着触发）', async () => {
    await enter();
    call('onReachBottom');
    call('onReachBottom');
    expect(calls).toHaveLength(2);
  });

  it('"下一页"失败：不清列表、给出错误、标志位复位（再触底能重试）', async () => {
    await enter();
    call('onReachBottom');
    calls[1]!.d.reject(new Error('boom'));
    await settle();
    expect(ids()).toHaveLength(20);
    expect(page.data['error']).not.toBe('');
    expect(page.data['loadingMore']).toBe(false);
    call('onReachBottom');
    expect(calls).toHaveLength(3);
  });
});
