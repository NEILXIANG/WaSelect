/**
 * 售后申请页薄壳（AJ-420）的接线：提交的路径 / 方法 / 请求体、成功出栈、失败留在本页并说清楚、在途不重复提交。
 *
 * @why 纯函数（vm）测的是"表单对不对"；这里测的是"点了提交真的发对了请求、成功真的回去了"——
 *      vm 全绿而薄壳把 id 拼错，买家看到的是 40400"订单不存在"。
 * @limitation 不渲染 wxml（mp-page @limitation 一）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let posts: Array<{ url: string; method: string | undefined; data: unknown }>;
let back: number;
let reply: () => Promise<unknown>;

const call = <T>(name: string, ...args: unknown[]): T =>
  (page[name] as (...a: unknown[]) => T)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

async function open(id: string | null = 'o-1'): Promise<void> {
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: { url: string; method?: string; data?: unknown }) => {
        posts.push({
          url: req.url.replace('http://api.test', ''),
          method: req.method,
          data: req.data,
        });
        return reply();
      },
    },
  });
  call('onLoad', id === null ? {} : { id });
}

function fill(): void {
  call('onReasonPick', { detail: { value: '1' } });
  call('onInput', { detail: { value: '  外箱压扁，罐子凹了  ' } });
}

beforeEach(() => {
  posts = [];
  back = 0;
  reply = async () => ({ after_sale: { id: 'as-1', status: 'open' } });
  vi.stubGlobal('wx', { navigateBack: () => (back += 1) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('售后申请页', () => {
  it('🔴 填好提交 → POST /orders/{id}/after-sales（原因值 + 去空白描述）→ 出栈回订单详情', async () => {
    await open();
    fill();
    expect(page.data['view']).toMatchObject({ reasonText: '商品破损', canSubmit: true });
    call('onSubmit');
    await settle();
    expect(posts).toEqual([
      {
        url: '/api/v1/orders/o-1/after-sales',
        method: 'POST',
        data: { reason: 'damaged', description: '外箱压扁，罐子凹了' },
      },
    ]);
    expect(back).toBe(1);
  });

  it('🔴 没选原因就点 → 不发请求，页面内提示', async () => {
    await open();
    call('onInput', { detail: { value: '罐子凹了' } });
    call('onSubmit');
    await settle();
    expect(posts).toEqual([]);
    expect(page.data['saveError']).toBe('请选择问题类型');
  });

  it('🔴 已有进行中的申请（40902）→ 留在本页说清楚，不出栈', async () => {
    reply = async () => {
      throw Object.assign(new Error('状态冲突'), {
        code: 40902,
        data: { reason: 'after_sale_open' },
      });
    };
    await open();
    fill();
    call('onSubmit');
    await settle();
    expect(back).toBe(0);
    expect(page.data['saveError']).toContain('已有进行中的售后申请');
    expect(page.data['submitting']).toBe(false);
  });

  it('🔴 提交在途时再点 → 不发第二次', async () => {
    const hold = deferred<unknown>();
    reply = () => hold.promise;
    await open();
    fill();
    call('onSubmit');
    call('onSubmit');
    await settle();
    expect(posts).toHaveLength(1);
    hold.resolve({});
    await settle();
    expect(back).toBe(1);
  });

  it('链接没有订单 id → 显示错误、不发请求', async () => {
    await open(null);
    fill();
    call('onSubmit');
    await settle();
    expect(page.data['error']).not.toBe('');
    expect(posts).toEqual([]);
  });

  it('页面已在 app.json 登记', () => {
    const app = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8')) as {
      pages: string[];
    };
    expect(app.pages).toContain('pages/after-sale/index');
  });
});
