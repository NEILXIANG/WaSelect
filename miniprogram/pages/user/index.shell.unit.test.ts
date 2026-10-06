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
