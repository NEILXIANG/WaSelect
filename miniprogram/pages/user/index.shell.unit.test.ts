/**
 * 职责：「我的」页薄壳（剩余清单 4-2：客服入口）——进屏拉 /support、只在有值时显示、点一行复制。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let urls: string[];
const clip: string[] = [];

async function open(support: unknown): Promise<void> {
  urls = [];
  clip.length = 0;
  vi.stubGlobal('wx', {
    setClipboardData: (o: { data: string; success?: () => void }) => {
      clip.push(o.data);
      o.success?.();
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
        if (u.endsWith('/api/v1/orders')) {
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

  it('🔴 进屏拉一次不带过滤的 GET /orders → 四入口角标（只数进行中）', async () => {
    await openWith({
      items: [{ status: 'created' }, { status: 'paid' }, { status: 'refunded' }],
    });
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
