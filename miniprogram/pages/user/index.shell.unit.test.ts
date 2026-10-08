/**
 * 职责：「我的」页薄壳（剩余清单 4-2：客服入口）——进屏拉 /support、只在有值时显示、点一行复制。
 */
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
