// @vitest-environment jsdom
/**
 * 职责：商品编辑表单的**组件行为**用例——保存撞上乐观锁冲突（40914）时表单必须还在（ADM3-02）。
 *
 * @why 整行 PUT 的编辑页是运营最重的输入面：十四个字段、可能填十几分钟。
 *      ADM3-02 给 PUT 加了 `expected_updated_at` 之后，"被别人改过"会变成一个**常态**响应，
 *      而不是异常。这时组件的两条行为决定了这次修的是不是**另一个**事故：
 *      ① 失败不能清表单——清了等于让运营凭记忆重填，而他会照着已经过期的旧值重填，
 *         等于第二次覆盖（正是 ADM3-02 要堵的洞，只是换了个方式发生）；
 *      ② 失败不能当成成功——`onDone` 一调用页面就回列表，红字一闪而过，
 *         运营以为保存了，实际整行没写。
 *      这两条都是"纯函数层全绿也照样发生"的缺陷，只有把组件挂起来才测得出来（AJ-229 同型）。
 *
 * @why 断言里要求错误文案给出**下一步**（"加载最新值对照"）而不只是复述码：
 *      只说"被别人改过了"，运营会原地再点一次保存——凭据没变，再撞一次。
 *      （P2-44 订正：旧的下一步是"重新进入编辑"，那会丢掉整张表单。）
 *
 * @see ./ProductFormPage.tsx；./api.ts（updateProduct 的 expectedUpdatedAt）；./view.ts（sourceUpdatedAt）
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type as typeInto, type Mounted } from '../testing/dom.js';
import { CATEGORY_LABELS, PRODUCT_CATEGORY } from './view.js';
import { ProductFormPage } from './ProductFormPage.js';

/** 一条带 `updated_at` 的商品（编辑页的 source；`updated_at` 是乐观锁凭据的来源）。 */
const SOURCE = {
  id: 'p-1',
  title: '資生堂 クレンジングオイル 200ml',
  category: 'beauty',
  price_jpy: 2980,
  weight_g: 320,
  stock: 12,
  status: 'active',
  customs_desc_en: 'cleansing oil 200ml',
  hs_code: '3304.99',
  origin_country: 'JP',
  compliance_tags: [],
  images: [],
  updated_at: '2026-10-01T00:00:00.000Z',
};

let mounted: Mounted | undefined;
let calls: Array<{ path: string; method?: string; body?: unknown }>;
let putCode = 0; // 0 = 成功
let doneCount = 0;

async function openWith(source: Record<string, unknown> | null): Promise<HTMLElement> {
  calls = [];
  doneCount = 0;
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    calls.push(req);
    if (putCode !== 0)
      throw new ApiError(putCode, '这条内容在你打开之后被别人改过了', 'trace-40914');
    return { id: 'p-1' };
  };
  mounted = await mount(
    createElement(ProductFormPage, {
      api: api as never,
      baseUrl: 'http://localhost',
      getToken: () => 'tk',
      productId: source === null ? null : String(source['id']),
      source: source as never,
      onDone: () => {
        doneCount += 1;
      },
    }),
  );
  return mounted.el;
}

const open = (): Promise<HTMLElement> => openWith(SOURCE);

/** 按标签文字取输入框（比按 DOM 顺序取稳：字段顺序调整不会让用例说谎）。 */
function field(el: HTMLElement, label: string): HTMLInputElement {
  for (const l of el.querySelectorAll('label.field')) {
    if ((l.querySelector('span.label')?.textContent ?? '').trim() === label) {
      const input = l.querySelector('input');
      if (input !== null) return input as HTMLInputElement;
    }
  }
  throw new Error(`找不到字段：${label}`);
}

const pageError = (el: HTMLElement): string => el.querySelector('p.error')?.textContent ?? '';

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  putCode = 0;
});

describe('商品编辑：保存撞上 40914（ADM3-02）', () => {
  it('🔴 表单内容**原样保留**、不回列表、保存按钮恢复可用', async () => {
    putCode = 40914;
    const el = await open();
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    await click(button(el, '保存'));

    expect(field(el, '商品名（面向买家）').value).toBe('改过的标题'); // 没被清空
    expect(doneCount).toBe(0); // 没被当成"保存成功"送回列表
    expect(button(el, '保存')?.disabled).toBe(false); // saving 已复位，可以再点
    // 凭据确实随请求发出了（否则这条用例只是在测一个永远不发生的分支）
    expect(calls[0]?.body).toMatchObject({ expected_updated_at: '2026-10-01T00:00:00.000Z' });
  });

  it('🔴 错误文案给出**下一步**（加载最新值对照），不是只复述错误码，也不叫人回列表', async () => {
    putCode = 40914;
    const el = await open();
    await click(button(el, '保存'));
    const msg = pageError(el);
    expect(msg).toContain('被别人改过了');
    expect(msg).toContain('加载最新值对照');
    expect(msg).toContain('内容都还在');
    expect(msg).not.toContain('返回列表');
    expect(button(el, '加载最新值对照')).not.toBeNull();
  });

  it('🔴 P2-44 加载最新值对照：表单不动、旁边列出最新值并标出不同；再保存带最新一版的凭据', async () => {
    const latest = { ...SOURCE, price_jpy: 3280, updated_at: '2026-10-02T00:00:00.000Z' };
    const reqs: Array<{ path: string; method?: string; body?: unknown }> = [];
    let puts = 0;
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      reqs.push(req);
      if (req.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new ApiError(40914, '这条内容在你打开之后被别人改过了', 't');
        return { id: 'p-1' };
      }
      return { items: [latest], total: 1 };
    };
    mounted = await mount(
      createElement(ProductFormPage, {
        api: api as never,
        baseUrl: 'http://localhost',
        getToken: () => 'tk',
        productId: 'p-1',
        source: SOURCE as never,
        onDone: () => undefined,
      }),
    );
    const el = mounted.el;
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    await click(button(el, '保存'));
    await click(button(el, '加载最新值对照'));
    expect(field(el, '商品名（面向买家）').value).toBe('改过的标题');
    const diffRows = [...el.querySelectorAll('tr')].map((tr) => tr.textContent ?? '');
    expect(
      diffRows.some((t) => t.includes('≠ 售价') && t.includes('2980') && t.includes('3280')),
    ).toBe(true);
    await click(button(el, '保存'));
    const lastPut = reqs.filter((r) => r.method === 'PUT').at(-1);
    expect(lastPut?.body).toMatchObject({
      title: '改过的标题',
      expected_updated_at: '2026-10-02T00:00:00.000Z',
    });
  });

  it('🔴 三端联动实测：改库存撞 40914（期间被买走一件）→ 加载最新值 → 再保存带**最新库存**作 expected_stock（否则无限冲突）', async () => {
    // 浏览器实测（2026-10-08）：运营打开时库存 12，期间买家买走一件（库里 11），运营改成 100 保存 → 40914；
    // 点「加载最新值对照」后再保存，旧实现仍带 expected_stock=12 → 服务端再 40914，永远保存不了。
    const latest = { ...SOURCE, stock: 11, updated_at: '2026-10-02T00:00:00.000Z' };
    const reqs: Array<{ path: string; method?: string; body?: unknown }> = [];
    let puts = 0;
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      reqs.push(req);
      if (req.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new ApiError(40914, '这条内容在你打开之后被别人改过了', 't');
        return { id: 'p-1' };
      }
      return { items: [latest], total: 1 };
    };
    mounted = await mount(
      createElement(ProductFormPage, {
        api: api as never,
        baseUrl: 'http://localhost',
        getToken: () => 'tk',
        productId: 'p-1',
        source: SOURCE as never,
        onDone: () => undefined,
      }),
    );
    const el = mounted.el;
    await typeInto(field(el, '库存'), '100');
    await click(button(el, '保存'));
    expect(reqs.filter((r) => r.method === 'PUT')[0]?.body).toMatchObject({
      stock: 100,
      expected_stock: 12,
    });
    await click(button(el, '加载最新值对照'));
    await click(button(el, '保存'));
    expect(reqs.filter((r) => r.method === 'PUT').at(-1)?.body).toMatchObject({
      stock: 100,
      expected_stock: 11,
    });
  });

  it('保存成功 → 回列表（对照组：上一条的"不回列表"是因为失败，不是因为压根没提交）', async () => {
    putCode = 0;
    const el = await open();
    await click(button(el, '保存'));
    expect(doneCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('🔴 编辑态拿不到 updated_at（脏数据 / 旧服务端）→ 就地拦下给明白话，请求一个都不发', async () => {
    const noCred: Record<string, unknown> = { ...SOURCE };
    delete noCred['updated_at']; // 模拟旧服务端 / 脏数据：行里没有版本字段
    const el = await openWith(noCred);
    await click(button(el, '保存'));
    expect(calls).toHaveLength(0); // 不发一个注定 40001 的请求
    expect(pageError(el)).toContain('缺少商品版本信息');
    expect(doneCount).toBe(0);
  });

  it('🔴 分类下拉由 PRODUCT_CATEGORY 生成（ADM3-08：新增分类时它必须跟着变）', async () => {
    const el = await openWith(SOURCE);
    const opts = [...el.querySelectorAll('select option')];
    expect(opts.map((o) => (o as HTMLOptionElement).value)).toEqual([...PRODUCT_CATEGORY]);
    // 文案也来自 CATEGORY_LABELS（约束五：不写死在组件里）
    expect(opts.map((o) => (o.textContent ?? '').trim())).toEqual(
      PRODUCT_CATEGORY.map((c) => CATEGORY_LABELS[c]),
    );
  });

  it('新建态不要求凭据：POST 体里**没有** expected_updated_at', async () => {
    const el = await openWith(null);
    await typeInto(field(el, '商品名（面向买家）'), 'Deba Knife 出刃包丁 165mm');
    await typeInto(field(el, '售价（円）'), '12800');
    await typeInto(field(el, '重量（克）'), '540');
    await typeInto(field(el, '英文报关品名（必填，D-39）'), 'kitchen knife');
    await typeInto(field(el, 'HS 编码（必填）'), '8211.91');
    await click(button(el, '保存'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).not.toHaveProperty('expected_updated_at');
    expect(doneCount).toBe(1);
  });
});

/** 编辑标签框里打了字没按回车就保存（A-04）：标签不能被悄悄丢掉。 */
describe('商品表单：未按回车的标签草稿（A-04）', () => {
  it('🔴 标签框有草稿时点保存 → 草稿并入 tags 一起提交', async () => {
    const el = await open();
    const tagInput = el.querySelector('input[placeholder^="输入后按回车添加"]');
    await typeInto(tagInput, '南部鉄器');
    await click(button(el, '保存'));
    const put = calls.find((c) => c.method === 'PUT');
    expect((put?.body as { tags?: string[] } | undefined)?.tags).toEqual(['南部鉄器']);
  });

  it('🔴 输入法合成中的回车（isComposing）不加入标签（A-09）', async () => {
    const el = await open();
    const tagInput = el.querySelector('input[placeholder^="输入后按回车添加"]') as HTMLInputElement;
    await typeInto(tagInput, 'なんぶ');
    tagInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await flush();
    expect(el.querySelectorAll('button[aria-label^="移除标签"]')).toHaveLength(0);
    expect(tagInput.value).toBe('なんぶ');
  });
});

/** 图片还在上传时点保存（A-08）：不能先把商品存下来、把这张图丢掉。 */
describe('商品表单：上传中不能保存（A-08）', () => {
  it('🔴 上传挂起时点保存 → 不发 PUT，按钮显示上传中', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof fetch;
    try {
      const el = await open();
      const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      const save = el.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      save.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
