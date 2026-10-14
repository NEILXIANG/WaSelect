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
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

interface Call {
  data: { page: number; category?: string; keyword?: string };
  d: ReturnType<typeof deferred<unknown>>;
}

let calls: Call[];
/** `GET /home` 的请求（轮播 + 分类）。**单独记录**，不进 `calls`。 */
let homeCalls: Array<{ d: ReturnType<typeof deferred<unknown>> }>;
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
  homeCalls = [];
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      cart: { count: () => 0 },
      api: (req: { url?: string; data: Call['data'] }) => {
        const d = deferred<unknown>();
        // ⚠️ 按 url 分流：进屏时 `/home` 与商品流是**并发的两个链路**，
        //    而下面"响应先后"那组用例全靠 `calls[n]` 的下标编排先后——
        //    把 /home 也塞进 `calls`，所有下标与 `toHaveLength` 会整体错位，
        //    表现是"列表突然是空的"，而真机上首页完全正常（典型的假红）。
        //    分流之后 `calls` 的含义也变清楚了：**它就是商品流请求**。
        if (String(req.url ?? '').includes('/api/v1/home')) {
          homeCalls.push({ d });
          return d.promise;
        }
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

  it('🔴 打了字没提交就切分类：新分类按已提交的关键词取，不按半截词搜（审计 BUG-06）', async () => {
    await enter();
    call('onSearchInput', { detail: { value: '抹茶' } });
    call('onCategoryTap', { currentTarget: { dataset: { key: 'food' } } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data.keyword ?? '').toBe('');
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
    // A11（2026-10-09）：错误改记在页脚 moreError（同样"给出错误"，只是不再占整块错误区）
    expect(page.data['moreError']).not.toBe('');
    expect(page.data['error']).toBe('');
    expect(page.data['loadingMore']).toBe(false);
    call('onReachBottom');
    expect(calls).toHaveLength(3);
  });
});

/** 进屏时发起了 `/home`（轮播 + 分类）与商品流**两个**请求。 */
/** 分类中文名（AJ-491：新版 /home 下发 category_tabs，键 + 名称）。 */
const NAMES: Record<string, string> = {
  beauty: '美妆护肤',
  daily: '生活百货',
  kitchen: '厨房餐具',
  food: '食品',
};
const home = (banners: unknown[], categories: string[]): void => {
  homeCalls[0]!.d.resolve({
    banners,
    categories,
    category_tabs: categories.map((key) => ({ key, name: NAMES[key] ?? key })),
  });
};

describe('首页薄壳：`GET /home`（轮播与分类，D-51）', () => {
  const BANNER = {
    id: 'b-1',
    image: 'https://img.example.com/banners/a.png',
    link_type: 'category',
    link_id: 'food',
  };

  it('进屏就发 `/home`，且与商品流**并发**（不等轮播回来才拉列表）', async () => {
    call('onLoad');
    expect(homeCalls).toHaveLength(1);
    // 商品流已经在途了 —— 不等 /home
    expect(calls).toHaveLength(1);
    expect(page.data['loading']).toBe(true);
  });

  it('🔴 `/home` 失败 → 商品流照常落地，**不给整页错误**（装饰层的失败不放大成整页失败）', async () => {
    call('onLoad');
    homeCalls[0]!.d.reject(new Error('home down'));
    calls[0]!.d.resolve(listOf('all', 1));
    await settle();
    expect(ids()).toHaveLength(20);
    expect(page.data['error']).toBe('');
    expect(page.data['slides']).toEqual([]);
    // AJ-491：不再用本地写死的分类兜底——/home 失败只剩「全部」（商品流照常，搜索照常）
    expect((page.data['tabs'] as Array<{ key: string }>).map((t) => t.key)).toEqual(['']);
  });

  it('`/home` 成功 → 轮播落地，且分类 tab **改用服务端下发的清单**', async () => {
    call('onLoad');
    calls[0]!.d.resolve(listOf('all', 1));
    home([BANNER], ['food', 'beauty']);
    await settle();
    // MP-1：slides 带 tappable（这张 banner 有跳转目标）
    expect(page.data['slides']).toEqual([
      { id: 'b-1', image: 'https://img.example.com/banners/a.png', tappable: true },
    ]);
    expect((page.data['tabs'] as Array<{ key: string }>).map((t) => t.key)).toEqual([
      '',
      'food',
      'beauty',
    ]);
  });

  it('🔴 `/home` 迟到（用户已切过分类才回来）→ tab 高亮**不跳回"全部"**', async () => {
    // @why 页面的 bug 形态是"我刚点了美妆，它自己跳回全部了"：
    //      loadHome 里若用空串重算 tab，就会覆盖掉用户已经做过的选择。
    call('onLoad');
    calls[0]!.d.resolve(listOf('all', 1));
    await settle();
    tapCategory('food');
    calls[1]!.d.resolve(listOf('food', 1));
    await settle();

    home([BANNER], ['food', 'beauty']);
    await settle();
    const active = (page.data['tabs'] as Array<{ key: string; active: boolean }>).filter(
      (t) => t.active,
    );
    expect(active).toEqual([{ key: 'food', label: '食品', active: true }]);
  });

  it('点轮播（link_type=category）→ 切到该分类，并**清掉当前搜索词**', async () => {
    call('onLoad');
    calls[0]!.d.resolve(listOf('all', 1));
    home([BANNER], ['food', 'beauty']);
    await settle();
    call('onSearchInput', { detail: { value: '抹茶' } });

    call('onBannerTap', { currentTarget: { dataset: { index: 0 } } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data).toMatchObject({ page: 1, category: 'food' });
    // 轮播说的是"去逛这个分类"，不是"在当前搜索结果里换分类"
    expect(calls[1]!.data.keyword).toBeUndefined();
    expect(page.data['keyword']).toBe('');
  });

  it('轮播里没有 image 的条目不进 slides（`IMG_BASE_URL` 未配置时不显示裂图）', async () => {
    call('onLoad');
    calls[0]!.d.resolve(listOf('all', 1));
    home([{ id: 'b-1', link_type: 'none' }], ['food']); // 服务端整键省略 image
    await settle();
    expect(page.data['slides']).toEqual([]);
  });
});

/**
 * MP3-08：搜索按钮上的 `loading` 守卫会**吞掉点击**（ws-button 在 loading 时静默 return），
 * 而 B36 之后 reload 本身就能安全并发、"最后一次赢"——这个守卫挡的不是并发，是"最后一次被发出去"。
 *
 * @why 写成源码守卫而不是行为用例：薄壳测试不渲染 wxml，`loading` 接在组件上时
 *      行为探针看不见它。而这条的形态特征很硬——"搜索按钮的标签里不得出现 loading="。
 */
// 用户 2026-10-11 截图问分类栏是否主流：改为文字 + 下划线（与订单页页签同一套），右侧「分类 ▾」展开全部分类网格
describe('首页分类：展开全部分类面板', () => {
  it('🔴 onToggleCats 打开 / 收起；在面板里选了分类后面板自动收起', async () => {
    call('onLoad');
    calls[0]!.d.resolve(listOf('all', 1));
    await settle();
    expect(page.data['catsOpen']).toBe(false);
    call('onToggleCats');
    expect(page.data['catsOpen']).toBe(true);
    call('onToggleCats');
    expect(page.data['catsOpen']).toBe(false);
    call('onToggleCats');
    tapCategory('food');
    expect(page.data['catsOpen']).toBe(false);
  });

  it('🔴 模板：分类多于 5 个才出现展开按钮；面板里的格子与分类栏同一个点击处理', () => {
    const src = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    expect(src).toMatch(
      /wx:if="\{\{tabs\.length > 6\}\}"[^>]*bindtap="onToggleCats"|bindtap="onToggleCats"[^>]*wx:if="\{\{tabs\.length > 6\}\}"/,
    );
    const panel =
      /<view\b[^>]*wx:if="\{\{catsOpen\}\}"[\s\S]*?<\/view>\s*<\/view>/.exec(src)?.[0] ?? '';
    expect(panel).toContain('bindtap="onCategoryTap"');
  });
});

// 2026-10-11 全入口点击测试：搜出结果后大幅轮播仍挡在结果上方，买家要往下翻才看到结果——搜索时收起轮播
describe('首页搜索时收起轮播', () => {
  it('🔴 swiper 的显示条件里带 !searching', () => {
    const src = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    const swiper = /<swiper\b[^>]*?wx:if="([^"]*)"/.exec(src)?.[1] ?? '';
    expect(swiper).toContain('!searching');
  });
});

describe('首页搜索按钮：不得用 loading 吞掉点击（MP3-08）', () => {
  const src = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');

  // 2026-10-11（用户截图指出搜索栏比例失调）：搜索入口从 ws-button 改为嵌在搜索框里的小号文字按钮（view），
  //   规则不变——不管是什么标签，绑定 onSearch 的那个都不得带 loading / disabled（会吞掉点击）
  it('🔴 bindtap 是 onSearch 的那个标签里没有 loading= / disabled=', () => {
    const tags = src.match(/<[a-z-]+\b[^>]*bindtap="onSearch"[^>]*>/g) ?? [];
    expect(tags.length, '至少有一个搜索按钮').toBeGreaterThan(0);
    for (const t of tags) expect(t, t).not.toMatch(/\s(loading|disabled)=/);
  });

  it('搜索按钮仍然存在，且键盘确认键走同一个处理函数（两个入口行为一致）', () => {
    expect(src).toMatch(/bindtap="onSearch"/);
    expect(src).toMatch(/bindconfirm="onSearch"/);
  });
});

describe('轮播点击的下标必须来自「可见 banner」列表（防复发）', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

  /**
   * @why 渲染用的是 `bannerSlides()`（已过滤），点击若直取 `this.banners[index]`（未过滤），
   *      下标只在"一条都没被跳过"时才相等 ⇒ 有一张没图就整体错位，表现为
   *      **点第 2 张跳到第 3 张的链接**（图是对的、没有报错，最难发现的那一类）。
   * @why 做成源码断言：过滤发生在 vm、点击发生在页面薄壳，两边分开演进，
   *      行为用例只能钉 vm 那半；"薄壳有没有用对函数"只有扫描能守住。
   */
  it('🔴 onBannerTap 走 bannerAt(，不能按渲染下标直取 this.banners[', () => {
    expect(src).toMatch(/bannerAt\(/);
    expect(src, 'this.banners[ 的下标是 slides 的下标，与未过滤数组不对齐').not.toMatch(
      /this\.banners\[/,
    );
  });
});

describe('首页薄壳：加载更多（审查 2026-10-09）', () => {
  it('🔴 第 2 页失败后再触底成功 → 页脚的失败提示消失', async () => {
    await enter();
    call('onReachBottom');
    calls[1]!.d.reject(Object.assign(new Error('timeout'), { code: -1 }));
    await settle();
    // A11（同日稍后）：下一页失败改记在页脚 `moreError`，不再占用整块的 `error`
    expect(page.data['moreError']).not.toBe('');
    call('onReachBottom');
    calls[2]!.d.resolve(listOf('all', 2, 60));
    await settle();
    expect(page.data['moreError']).toBe('');
    expect(page.data['error']).toBe('');
    expect(ids()).toHaveLength(40);
  });

  it('🔴 第 2 页与第 1 页重叠一件（中途上新）→ 不重复显示；hasMore 按服务端偏移算，不因去重提前变 false', async () => {
    await enter(); // 第 1 页 20 件，total 40
    call('onReachBottom');
    const p2 = listOf('all', 2, 41); // 上新一件后 total=41
    p2.items[0] = { ...listOf('all', 1).items[19]! }; // 第 2 页第一件 = 第 1 页最后一件
    calls[1]!.d.resolve(p2);
    await settle();
    const list = ids();
    expect(new Set(list).size).toBe(list.length);
    expect(list).toHaveLength(39);
    expect(page.data['hasMore']).toBe(true); // 服务端已给 40 条（偏移 40）< 41
  });
});

describe('首页：搜索状态与加载更多失败（小程序评估 A4 / A11，2026-10-09）', () => {
  it('🔴 搜索后显示"搜索「xx」的结果"；点「清除搜索」→ 词清空、按全部重新取', async () => {
    await enter();
    call('onSearchInput', { detail: { value: '抹茶' } });
    call('onSearch');
    expect(page.data['searching']).toBe('抹茶');
    calls.at(-1)!.d.resolve(listOf('kw', 1, 20));
    await settle();
    call('onClearSearch');
    expect(page.data['keyword']).toBe('');
    expect(page.data['searching']).toBe('');
    expect(calls.at(-1)!.data.keyword ?? '').toBe('');
  });

  it('🔴 加载下一页失败 → 不出整块错误、列表保留；页脚"加载失败，点此重试"只重拉这一页', async () => {
    await enter();
    call('onReachBottom');
    calls[1]!.d.reject(Object.assign(new Error('timeout'), { code: -1 }));
    await settle();
    expect(page.data['error']).toBe('');
    expect(page.data['moreError']).not.toBe('');
    expect(ids()).toHaveLength(20);
    call('onMoreRetry');
    expect(calls.at(-1)!.data.page).toBe(2);
    calls.at(-1)!.d.resolve(listOf('all', 2));
    await settle();
    expect(page.data['moreError']).toBe('');
    expect(ids()).toHaveLength(40);
  });
});

// 第 24 项（2026-10-10）：首页下拉刷新——订单页 / 详情页早有（M-04），首页没有：运营改了 Banner / 上新，买家只能杀掉小程序重进
describe('首页：下拉刷新', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 轮播与商品流（第 1 页）都重取，两条都回来才收起动画', async () => {
    const stops: number[] = [];
    vi.stubGlobal('wx', { stopPullDownRefresh: () => stops.push(1) });
    call('onLoad');
    homeCalls[0]?.d.resolve({ banners: [], categories: [] });
    calls[0]?.d.resolve(listOf('all', 1));
    await settle();
    const done = call<Promise<void>>('onPullDownRefresh');
    await settle();
    expect(homeCalls).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.data.page).toBe(1);
    homeCalls[1]?.d.resolve({ banners: [], categories: [] });
    await settle();
    expect(stops).toEqual([]);
    calls[1]?.d.resolve(listOf('all', 1));
    await done;
    expect(stops).toEqual([1]);
  });
});
