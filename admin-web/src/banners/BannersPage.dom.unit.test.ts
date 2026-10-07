// @vitest-environment jsdom
/**
 * 职责：Banner 页的组件行为用例——上传过程中切换编辑对象，图不能写进另一条（A-07）。
 *
 * @why 上传要几秒，期间「编辑」「新建」都还能点；原实现上传完成后把 image_key 写进**当时**的表单，
 *      运营改完另一条的排序点保存，那一条的图就被替换成本想给前一条的图。
 * @see ./BannersPage.tsx
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type, type Mounted } from '../testing/dom.js';
import { BannersPage } from './BannersPage.js';

let mounted: Mounted | undefined;

const banner = (id: string, image_key: string) => ({
  id,
  image: `https://img.example.com/${image_key}`,
  image_key,
  link_type: 'none',
  link_value: null,
  sort: 1,
  active: true,
  starts_at: null,
  ends_at: null,
  updated_at: `2026-10-0${id === 'b-A' ? '1' : '2'}T00:00:00.000Z`,
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('Banner：上传中切换编辑对象（A-07）', () => {
  it('🔴 编辑 A 时上传，上传期间改为编辑 B → 上传结果不写进 B 的表单', async () => {
    let resolveUpload: (v: Response) => void = () => undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise<Response>((r) => {
        resolveUpload = r;
      })) as typeof fetch;
    const puts: Array<{ path: string; body?: unknown }> = [];
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      if (req.method === 'PUT') puts.push(req);
      return [banner('b-A', 'banners/a.webp'), banner('b-B', 'banners/b.webp')];
    };
    try {
      mounted = await mount(
        createElement(BannersPage, {
          api: api as never,
          baseUrl: 'http://localhost',
          getToken: () => 'tk',
          onUnauthorized: () => undefined,
        }),
      );
      const el = mounted.el;
      const edits = [...el.querySelectorAll('button')].filter((b) => b.textContent === '编辑');
      await click(edits[0]);
      const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })],
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      await click(edits[1]);
      resolveUpload(
        new Response(JSON.stringify({ image_key: 'banners/new.webp', image_id: 'img-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await flush();
      await flush();
      await click(button(el, '保存'));
      const body = puts.at(-1)?.body as { image_key?: string } | undefined;
      expect(puts.at(-1)?.path).toContain('b-B');
      expect(body?.image_key).toBe('banners/b.webp');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** 保存时带乐观锁凭据（S-09）：服务端据它拒绝"覆盖了别人改动"的保存。 */
describe('Banner：保存带 expected_updated_at（S-09）', () => {
  it('🔴 编辑后保存 → PUT 体里带上列表回显的 updated_at', async () => {
    const puts: Array<{ path: string; body?: unknown }> = [];
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      if (req.method === 'PUT') puts.push(req);
      return [banner('b-A', 'banners/a.webp')];
    };
    mounted = await mount(
      createElement(BannersPage, {
        api: api as never,
        baseUrl: 'http://localhost',
        getToken: () => 'tk',
        onUnauthorized: () => undefined,
      }),
    );
    const el = mounted.el;
    await click([...el.querySelectorAll('button')].find((b) => b.textContent === '编辑'));
    await click(button(el, '保存'));
    expect((puts.at(-1)?.body as { expected_updated_at?: string }).expected_updated_at).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

describe('Banner：保存撞上 40914（P2-44）', () => {
  it('🔴 表单原地保留 → 加载最新值对照 → 标出不同 → 再保存带最新一版的凭据', async () => {
    const puts: Array<{ path: string; body?: unknown }> = [];
    let listCalls = 0;
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      if (req.method === 'PUT') {
        puts.push(req);
        if (puts.length === 1) throw new ApiError(40914, '这条内容在你打开之后被别人改过了', 't');
        return {};
      }
      listCalls += 1;
      // 第一次列表是打开时的版本；之后是别人改过排序的最新版
      return listCalls === 1
        ? [banner('b-A', 'banners/a.webp')]
        : [{ ...banner('b-A', 'banners/a.webp'), sort: 9, updated_at: '2026-10-05T00:00:00.000Z' }];
    };
    mounted = await mount(
      createElement(BannersPage, {
        api: api as never,
        baseUrl: 'http://localhost',
        getToken: () => 'tk',
        onUnauthorized: () => undefined,
      }),
    );
    const el = mounted.el;
    await click([...el.querySelectorAll('button')].find((b) => b.textContent === '编辑'));
    await type(el.querySelector('input[placeholder="排序（小的在前）"]'), '3');
    await click(button(el, '保存'));
    expect(el.textContent).toContain('加载最新值对照');
    expect(el.textContent).not.toContain('取消编辑」后重新打开');
    await click(button(el, '加载最新值对照'));
    expect(
      (el.querySelector('input[placeholder="排序（小的在前）"]') as HTMLInputElement).value,
    ).toBe('3');
    const rows = [...el.querySelectorAll('tr')].map((tr) => tr.textContent ?? '');
    expect(rows.some((t) => t.includes('≠ 排序') && t.includes('3') && t.includes('9'))).toBe(true);
    await click(button(el, '保存'));
    expect(puts.at(-1)?.body).toMatchObject({
      sort: 3,
      expected_updated_at: '2026-10-05T00:00:00.000Z',
    });
  });
});
