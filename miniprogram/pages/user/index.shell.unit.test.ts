/**
 * 职责：「我的」页薄壳（剩余清单 4-2：客服入口）——进屏拉 /support、只在有值时显示、点一行复制。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let urls: string[];
const clip: string[] = [];
let clipFail = false;

async function open(support: unknown): Promise<void> {
  urls = [];
  clip.length = 0;
  vi.stubGlobal('wx', {
    setClipboardData: (o: { data: string; success?: () => void; fail?: () => void }) => {
      clip.push(o.data);
      if (clipFail) o.fail?.();
      else o.success?.();
    },
    navigateTo: () => undefined,
    switchTab: () => undefined,
  });
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      token: 't',
      api: (req: { url?: string }) => {
        urls.push(String(req.url));
        return Promise.resolve(support);
      },
    },
  });
  (page['onShow'] as () => void)();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clipFail = false;
});

describe('「我的」客服入口（4-2）', () => {
  it('🔴 进屏请求 /support；有值 → support 行；点微信号一行 → 复制并标"已复制"', async () => {
    await open({ wechat: 'waselect_cs', email: 'support@example.com' });
    expect(urls).toContain('http://api.test/api/v1/support');
    const rows = page.data['support'] as Array<{ key: string; value: string }>;
    expect(rows.map((r) => r.key)).toEqual(['wechat', 'email']);
    (page['onCopySupport'] as (e: unknown) => void)({
      currentTarget: { dataset: { key: 'wechat', value: 'waselect_cs' } },
    });
    expect(clip).toEqual(['waselect_cs']);
    expect(page.data['supportCopied']).toBe('wechat');
  });

  it('🔴 复制失败 → 那一行说"复制失败，请长按手动复制"，不再静默（审计 ITX-05）', async () => {
    await open({ wechat: 'waselect_cs' });
    clipFail = true;
    (page['onCopySupport'] as (e: unknown) => void)({
      currentTarget: { dataset: { key: 'wechat', value: 'waselect_cs' } },
    });
    expect(page.data['supportCopyFailed']).toBe('wechat');
    expect(page.data['supportCopied']).toBe('');
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toContain("supportCopyFailed === item.key ? '复制失败，请长按手动复制'");
  });

  it('客服未配置（空对象）或请求失败 → support 为空数组（不显示客服卡，也不报错打扰）', async () => {
    await open({});
    expect(page.data['support']).toEqual([]);
  });
});

describe('「我的」重新登录（M-17，AJ-406）', () => {
  async function openFailed(retryLogin: unknown): Promise<{ g: Record<string, unknown> }> {
    vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
    const g: Record<string, unknown> = {
      apiBase: 'http://api.test',
      token: '',
      loginFailed: true,
      retryLogin,
      api: () => Promise.resolve({}),
    };
    page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: g });
    (page['onShow'] as () => void)();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    return { g };
  }
  const retry = () => page.data['retry'] as { show: boolean; text: string; note: string };

  it('🔴 启动登录失败 → 有按钮；点了成功 → 登录态变"已登录"、按钮消失', async () => {
    let calls = 0;
    const { g } = await openFailed(() => {
      calls += 1;
      g['token'] = 'tok-new';
      g['loginFailed'] = false;
      return Promise.resolve({ ok: true });
    });
    expect(retry().show).toBe(true);
    await (page['onRetryLogin'] as () => Promise<void>)();
    expect(calls).toBe(1);
    expect((page.data['login'] as { logged: boolean }).logged).toBe(true);
    expect(retry().show).toBe(false);
  });

  it('重试又失败 → 按钮还在，并说明"还是没有登录成功"', async () => {
    await openFailed(() => Promise.resolve({ ok: false }));
    await (page['onRetryLogin'] as () => Promise<void>)();
    expect(retry().show).toBe(true);
    expect(retry().note).toBe('还是没有登录成功，请检查网络后再试');
  });

  it('在途时再点 → 不发第二次', async () => {
    let calls = 0;
    let release: (v: unknown) => void = () => undefined;
    await openFailed(() => {
      calls += 1;
      return new Promise((r) => {
        release = r;
      });
    });
    const first = (page['onRetryLogin'] as () => Promise<void>)();
    void (page['onRetryLogin'] as () => Promise<void>)();
    expect(retry().text).toBe('正在重新登录…');
    release({ ok: false });
    await first;
    expect(calls).toBe(1);
  });

  it('没有重试入口（没配 API 地址：retryLogin 为 null）→ 不显示按钮', async () => {
    await openFailed(null);
    expect(retry().show).toBe(false);
  });
});

describe('「我的」四个订单入口（M-10 附，AJ-408）', () => {
  let g: Record<string, unknown>;
  let switched: string[];
  async function openWith(orders: unknown, fail = false): Promise<void> {
    switched = [];
    vi.stubGlobal('wx', {
      navigateTo: () => undefined,
      switchTab: (o: { url: string }) => switched.push(o.url),
    });
    g = {
      apiBase: 'http://api.test',
      token: 't',
      orderTab: '',
      api: (req: { url?: string }) => {
        const u = String(req.url);
        if (u.endsWith('/api/v1/orders/counts')) {
          return fail ? Promise.reject(new Error('网络请求失败')) : Promise.resolve(orders);
        }
        return Promise.resolve({});
      },
    };
    page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: g });
    (page['onShow'] as () => void)();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
  const shortcuts = () => page.data['shortcuts'] as Array<{ key: string; badge: string }>;

  it('🔴 进屏拉一次 GET /orders/counts → 四入口角标（S-7：服务端计数）', async () => {
    await openWith({ unpaid: 1, to_ship: 1, shipped: 0, after_sale: 0 });
    expect(shortcuts().map((s) => [s.key, s.badge])).toEqual([
      ['unpaid', '1'],
      ['to_ship', '1'],
      ['shipped', ''],
      ['after_sale', ''],
    ]);
  });

  it('取数失败 → 入口照常、无角标（静默，不打扰）', async () => {
    await openWith(undefined, true);
    expect(shortcuts().map((s) => s.badge)).toEqual(['', '', '', '']);
  });

  it('🔴 点入口 → 写一次性页签意图 + switchTab 到订单页（tab 页不能带 query）', async () => {
    await openWith({ items: [] });
    (page['onShortcutTap'] as (e: unknown) => void)({
      currentTarget: { dataset: { key: 'after_sale' } },
    });
    expect(g['orderTab']).toBe('after_sale');
    expect(switched).toEqual(['/pages/order/index']);
  });

  it('⚠️ 认不出的 key → 不跳、不写意图', async () => {
    await openWith({ items: [] });
    (page['onShortcutTap'] as (e: unknown) => void)({
      currentTarget: { dataset: { key: 'constructor' } },
    });
    expect(g['orderTab']).toBe('');
    expect(switched).toEqual([]);
  });

  it('「我的订单」一行 → 意图为「全部」（否则会停在上次从入口进的页签）', async () => {
    await openWith({ items: [] });
    (page['onMenuTap'] as (e: unknown) => void)({ currentTarget: { dataset: { key: 'orders' } } });
    expect(g['orderTab']).toBe('all');
    expect(switched).toEqual(['/pages/order/index']);
  });
});

describe('「我的」登录态跟着变（审查 2026-10-09）', () => {
  it('🔴 进屏时自动登录还在途 → 登录完成后页面自己变成"已登录"，不用切走再回来', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
      const g: Record<string, unknown> = {
        apiBase: 'http://api.test',
        token: '',
        loginFailed: false,
        retryLogin: () => Promise.resolve(),
        api: () => Promise.resolve({}),
      };
      page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: g });
      (page['onShow'] as () => void)();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect((page.data['login'] as { logged: boolean }).logged).toBe(false);
      g['token'] = 'tok-after-login'; // 启动登录此刻完成
      await vi.advanceTimersByTimeAsync(1000);
      expect((page.data['login'] as { logged: boolean }).logged).toBe(true);
      (page['onHide'] as () => void)();
    } finally {
      vi.useRealTimers();
    }
  });

  it('自动登录失败 → 页面同样自己变成"重新登录"按钮', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
      const g: Record<string, unknown> = {
        apiBase: 'http://api.test',
        token: '',
        loginFailed: false,
        retryLogin: () => Promise.resolve(),
        api: () => Promise.resolve({}),
      };
      page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: g });
      (page['onShow'] as () => void)();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      g['loginFailed'] = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect((page.data['retry'] as { show: boolean }).show).toBe(true);
      (page['onHide'] as () => void)();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('「我的」模板：登录成功后不再占一行（小程序评估，AJ-416）', () => {
  it('🔴 登录态卡片只在"没登上 / 正在登 / 要重试"时出现——登录成功后那行"已登录"没有信息量', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toMatch(/class="ws-gutter"[^>]*wx:if="\{\{!login\.logged \|\| retry\.show\}\}"/);
  });
});

// 第 24 项（2026-10-10）：「我的」下拉刷新——订单角标与客服信息只在进屏时取，停留在本页时下单 / 付款后角标不更新
describe('「我的」：下拉刷新', () => {
  it('🔴 页面 json 开了 enablePullDownRefresh', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      enablePullDownRefresh?: boolean;
    };
    expect(json.enablePullDownRefresh).toBe(true);
  });

  it('🔴 下拉 → 重取客服信息与订单角标，两条都回来才收起动画', async () => {
    await open({ wechat: 'waselect_cs', items: [] });
    const stops: number[] = [];
    vi.stubGlobal('wx', { stopPullDownRefresh: () => stops.push(1) });
    urls.length = 0;
    const done = (page['onPullDownRefresh'] as () => Promise<void>)();
    expect(stops).toEqual([]);
    await done;
    expect(urls.sort()).toEqual([
      'http://api.test/api/v1/orders/counts',
      'http://api.test/api/v1/support',
    ]);
    expect(stops).toEqual([1]);
  });
});

// 全入口点击测试 2026-10-11：有角标的入口文字被顶下去一截、与其它三个对不齐；角标颜色与底栏购物车角标不一致；
// 「我的订单」与四入口卡片重复。改为：订单卡片带标题行「我的订单 · 全部订单 ›」，角标挂在文字右上（不占位）、用同一个红
describe('「我的」订单卡片（全入口点击测试 2026-10-11）', () => {
  const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  const wxss = readFileSync(new URL('./index.wxss', import.meta.url), 'utf8');

  it('🔴 订单卡片有标题行：点它走 onMenuTap（key=orders → 全部页签）', () => {
    expect(wxml).toMatch(
      /class="mine__orders-head"[^>]*data-key="\{\{ordersEntry.key\}\}"[^>]*bindtap="onMenuTap"/,
    );
    expect(wxml).toContain('{{ordersEntry.actionText}}');
  });

  it('🔴 角标挂在文字右上、不占位（absolute），颜色与底栏购物车角标同为 --ws-danger', () => {
    expect(wxml).toMatch(
      /<view class="mine__order-label-wrap">\s*<text class="mine__order-label">/,
    );
    const badge = /\.mine__order-badge\s*\{([^}]*)\}/.exec(wxss)?.[1] ?? '';
    expect(badge).toContain('position: absolute');
    expect(badge).toContain('background: var(--ws-danger)');
  });
});

// 全入口点击测试 2026-10-11：客服微信 / 邮箱能点复制，但界面上没有任何"复制"字样；行距也比上面的菜单挤。
// 改为：可复制的行右侧写「复制」（复制后「已复制」），号码本身不被替换
describe('「我的」联系客服（全入口点击测试 2026-10-11）', () => {
  const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  it('🔴 可复制的行有「复制」字样，复制后变「已复制」；号码照常显示', () => {
    expect(wxml).toMatch(
      /<text class="mine__support-act" wx:if="\{\{item\.copyable\}\}">\{\{supportCopied === item\.key \? '已复制' : supportCopyFailed === item\.key \? '复制失败，请长按手动复制' : '复制'\}\}<\/text>/,
    );
    expect(wxml).toMatch(
      /<text class="mine__value mine__support-value" user-select>\{\{item\.value\}\}<\/text>/,
    );
  });
});

// 独立审查 2026-10-13 【3】：本页原先没有页面级 trace，角标 / 客服两条请求在服务端日志里是孤链
describe('「我的」：请求带页面级 traceId', () => {
  it('🔴 onShow 后 /orders/counts 与 /support 都带同一个非空 traceId', async () => {
    const seen: Array<{ url: string; traceId: string | undefined }> = [];
    vi.stubGlobal('wx', { navigateTo: () => undefined, switchTab: () => undefined });
    const p = await loadPage(new URL('./index.js', import.meta.url).href, {
      globalData: {
        apiBase: 'http://api.test',
        token: 't',
        orderTab: '',
        api: (req: { url: string; traceId?: string }) => {
          seen.push({ url: req.url, traceId: req.traceId });
          return Promise.resolve(req.url.endsWith('/support') ? [] : {});
        },
      },
    });
    (p['onShow'] as () => void)();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const ids = seen
      .filter((s) => /\/orders\/counts$|\/support$/.test(s.url))
      .map((s) => s.traceId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.every((t) => typeof t === 'string' && t !== '')).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });
});
