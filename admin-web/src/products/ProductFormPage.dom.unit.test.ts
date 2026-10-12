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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { UnsavedProvider, useDirtyRegistry, useUnsaved } from '../ui/unsaved.js';
import { button, click, flush, mount, type as typeInto, type Mounted } from '../testing/dom.js';
import { primeCategoryCache } from '../categories/useCategories.js';
import { TEST_CATEGORIES } from '../testing/categories.js';
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
let putData: Record<string, unknown> | undefined;
let doneCount = 0;

async function openWith(source: Record<string, unknown> | null): Promise<HTMLElement> {
  calls = [];
  doneCount = 0;
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    calls.push(req);
    if (putCode !== 0)
      throw new ApiError(
        putCode,
        putCode === 40001 ? '参数缺失或格式错误' : '这条内容在你打开之后被别人改过了',
        'trace-40914',
        putData === undefined ? undefined : { data: putData },
      );
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
    // AJ-410 / N24：必填项标签后多了「 *必填」标记，按字段名匹配时去掉它
    const text = (l.querySelector('span.label')?.textContent ?? '').replace(/\s*\*必填$/, '');
    if (text.trim() === label) {
      const input = l.querySelector('input');
      if (input !== null) return input as HTMLInputElement;
    }
  }
  throw new Error(`找不到字段：${label}`);
}

/** 页面级错误提示的文本（审查 2026-10-09：改走右下角 Toast；只取提示正文，不含报障码行与关闭按钮）。 */
/** 选分类（AJ-491：新建时分类留空、必须手选）。 */
async function pickCategory(el: HTMLElement, key: string): Promise<void> {
  await typeInto(el.querySelector('select'), key);
}

const pageError = (el: HTMLElement): string =>
  el.querySelector('.toast[data-kind="error"] .toast-text')?.textContent ?? '';

/**
 * 脏态探针：把 Provider 那一份 `dirty` 显示在 DOM 上，供断言读取。
 * @why 不直接读 hook 的返回值——组件内部状态读不到，而把它渲染出来正好就是
 *      "App 的侧栏按钮看见的那个值"（App.tsx 用同一个 Provider）。
 */
function Probe(): JSX.Element {
  const { dirty } = useUnsaved();
  return createElement('span', { 'data-testid': 'dirty' }, dirty ? 'yes' : 'no');
}

function Host(props: Record<string, unknown>): JSX.Element {
  const { dirty, markDirty } = useDirtyRegistry();
  return createElement(
    UnsavedProvider,
    { dirty, markDirty },
    createElement(Probe),
    createElement(ProductFormPage, props as never),
  );
}

/** 带脏态 Provider 打开编辑页（返回el 里含 [data-testid=dirty] 探针）。 */
async function openWithDirty(source: Record<string, unknown> | null): Promise<HTMLElement> {
  calls = [];
  doneCount = 0;
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    calls.push(req);
    if (putCode !== 0) throw new ApiError(putCode, '这条内容在你打开之后被别人改过了', 't');
    return { id: 'p-1' };
  };
  mounted = await mount(
    createElement(Host, {
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

const dirtyOf = (el: HTMLElement): string =>
  el.querySelector('[data-testid="dirty"]')?.textContent ?? '';

beforeEach(() => {
  primeCategoryCache(TEST_CATEGORIES);
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  putCode = 0;
  putData = undefined;
});

// AJ-488（三端模拟测试 2026-10-11）：售价填 999,999 保存只见"参数缺失或格式错误"
describe('商品编辑：服务端校验失败（40001 带 field / reason）', () => {
  it('🔴 出错的输入框下标出原因；顶部说清改哪一项、还有几处；不显示原因码', async () => {
    putCode = 40001;
    putData = { field: 'price_jpy', reason: 'price_too_large', count: 2 };
    const el = await open();
    await click(button(el, '保存'));
    const msg = pageError(el);
    expect(msg).toContain('售价超过单笔订单上限');
    expect(msg).toContain('还有 1 处');
    expect(msg).not.toContain('price_too_large');
    expect(field(el, '售价（日元）').closest('label.field')?.textContent).toContain(
      '售价超过单笔订单上限',
    );
    expect(doneCount).toBe(0);
  });
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

  // AJ-491：分类改为后台可配置——下拉来自 /admin/categories：只列启用的，名称来自后台（ADM3-08：新增分类时它跟着变）
  it('🔴 分类下拉来自后台分类列表：启用的按排序，停用的不出现；新建时第一项是「请选择分类」', async () => {
    const el = await openWith(SOURCE);
    const opts = [...el.querySelectorAll('select option')];
    expect(opts.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'beauty',
      'daily',
      'kitchen',
      'food',
    ]);
    expect(opts.map((o) => (o.textContent ?? '').trim())).toEqual([
      '美妆护肤',
      '生活百货',
      '厨房餐具',
      '食品',
    ]);
    await mounted?.unmount();
    mounted = undefined;
    const fresh = await openWith(null);
    const first = fresh.querySelector('select option') as HTMLOptionElement;
    expect([first.value, first.textContent]).toEqual(['', '请选择分类']);
  });

  it('新建态不要求凭据：POST 体里**没有** expected_updated_at', async () => {
    const el = await openWith(null);
    await typeInto(field(el, '商品名（面向买家）'), 'Deba Knife 出刃包丁 165mm');
    await typeInto(field(el, '售价（日元）'), '12800');
    await typeInto(field(el, '重量（克）'), '540');
    await typeInto(field(el, '英文报关品名'), 'kitchen knife');
    await typeInto(field(el, 'HS 编码'), '8211.91');
    await pickCategory(el, 'kitchen'); // AJ-491：新建必须手选分类
    // 新建库存默认留空、必填（三端联动 UI 模拟 2026-10-08）：不填先被拦
    expect(field(el, '库存').value).toBe('');
    // AJ-403：新建的保存按钮叫「保存为草稿」（新建恒为草稿；另有「保存并上架」）
    await click(button(el, '保存为草稿'));
    expect(calls).toHaveLength(0);
    await typeInto(field(el, '库存'), '30');
    await click(button(el, '保存为草稿'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({ stock: 30 });
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
      const save = button(el, '图片上传中…') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      await click(save);
      await flush();
      expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * 未保存提醒的**上报端**（第一批⑥）。
 *
 * @why 这一段才是这层改动真正会跑偏的地方：`ProductFormPage` 要维护"未改动基线"，
 *      而"什么才算改动"很容易写漏（改了标签草稿算不算？保存成功后要不要复位？）。
 *      ①②两条把最容易错的两处钉住；App 侧拦截本身在 App.tsx 里只有几行，靠 review。
 */
describe('商品表单：未保存改动上报（第一批⑥）', () => {
  it('刚打开不脏；改一个字段立刻变脏', async () => {
    const el = await openWithDirty(SOURCE);
    expect(dirtyOf(el)).toBe('no');
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    expect(dirtyOf(el)).toBe('yes');
  });

  it('改回去（与原值一致）→ 重新变干净：提醒不该为"看了一眼"而弹', async () => {
    const el = await openWithDirty(SOURCE);
    const input = field(el, '商品名（面向买家）');
    const original = input.value;
    await typeInto(input, '临时改动');
    expect(dirtyOf(el)).toBe('yes');
    await typeInto(input, original);
    expect(dirtyOf(el)).toBe('no');
  });

  it('🔴 保存成功后必须复位成不脏（否则点侧栏还会被"要离开吗"拦一次）', async () => {
    const el = await openWithDirty(SOURCE);
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    expect(dirtyOf(el)).toBe('yes');
    await click(button(el, '保存'));
    expect(doneCount).toBe(1);
    expect(dirtyOf(el)).toBe('no');
  });

  it('保存失败（40914）不清表单 → 仍然是脏的（那次改动确实还没保存）', async () => {
    putCode = 40914;
    const el = await openWithDirty(SOURCE);
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    await click(button(el, '保存'));
    expect(dirtyOf(el)).toBe('yes');
  });
});

/**
 * AJ-403（第二批 C）：草稿 / 保存并上架 / 分组布局 / 图片排序。
 * 假服务端按真服务端的形状回：POST 回整行（status=draft + updated_at），PUT 回整行，PATCH status 回 {id, status}。
 */
describe('商品表单：草稿与保存并上架（AJ-403）', () => {
  let reqs: Array<{ path: string; method?: string; body?: unknown }>;
  let publishFails: boolean;
  let doneMsgs: Array<string | undefined>;

  async function openForm(source: Record<string, unknown> | null): Promise<HTMLElement> {
    reqs = [];
    doneMsgs = [];
    const api = async (req: {
      path: string;
      method?: string;
      body?: unknown;
    }): Promise<unknown> => {
      reqs.push(req);
      if (req.method === 'POST')
        return { id: 'p-new', status: 'draft', stock: 30, updated_at: '2026-10-07T01:00:00.000Z' };
      if (req.method === 'PUT')
        return { id: 'p-new', status: 'draft', stock: 30, updated_at: '2026-10-07T02:00:00.000Z' };
      if (req.method === 'PATCH') {
        if (publishFails)
          throw new ApiError(40918, '运费表最高档装不下这件商品（含包材重量）', 't-40918');
        return { id: 'p-new', status: 'active' };
      }
      return { items: [], total: 0 };
    };
    mounted = await mount(
      createElement(ProductFormPage, {
        api: api as never,
        baseUrl: 'http://localhost',
        getToken: () => 'tk',
        productId: source === null ? null : String(source['id']),
        source: source as never,
        onDone: (m?: string) => {
          doneMsgs.push(m);
        },
      }),
    );
    return mounted.el;
  }

  async function fillNew(el: HTMLElement): Promise<void> {
    await typeInto(field(el, '商品名（面向买家）'), 'Nambu Tekki 南部鉄器 急須 0.65L');
    await typeInto(field(el, '售价（日元）'), '9800');
    await typeInto(field(el, '重量（克）'), '1200');
    await typeInto(field(el, '库存'), '30');
    await typeInto(field(el, '英文报关品名'), 'cast iron teapot');
    await typeInto(field(el, 'HS 编码'), '7323.91');
    // AJ-491：新建时分类留空、必须手选（不再默认第一类）
    await pickCategory(el, 'kitchen');
  }

  it('🔴 新建：「保存为草稿」只发 POST，回列表并说"草稿"', async () => {
    publishFails = false;
    const el = await openForm(null);
    expect(button(el, '保存')).toBeNull(); // 新建没有含糊的"保存"：要么草稿、要么上架
    await fillNew(el);
    await click(button(el, '保存为草稿'));
    expect(reqs.map((r) => r.method)).toEqual(['POST']);
    expect(doneMsgs).toHaveLength(1);
    expect(doneMsgs[0]).toContain('草稿');
  });

  it('🔴 新建：「保存并上架」= POST 后 PATCH /{新 id}/status active，回列表并说"上架"', async () => {
    publishFails = false;
    const el = await openForm(null);
    await fillNew(el);
    await click(button(el, '保存并上架'));
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/v1/admin/products',
      'PATCH /api/v1/admin/products/p-new/status',
    ]);
    expect(reqs[1]?.body).toEqual({ status: 'active' });
    expect(doneMsgs[0]).toContain('上架');
  });

  it('🔴 新建后上架失败（40918）：留在页面、转为编辑态；再点「保存并上架」走 PUT（不重复建）并带 POST 回来的凭据', async () => {
    publishFails = true;
    const el = await openForm(null);
    await fillNew(el);
    await click(button(el, '保存并上架'));
    expect(doneMsgs).toHaveLength(0);
    expect(pageError(el)).toContain('已保存为草稿');
    expect(pageError(el)).toContain('运费表最高档装不下');
    expect(el.querySelector('h1')?.textContent).toBe('编辑商品');
    publishFails = false;
    await click(button(el, '保存并上架'));
    const methods = reqs.map((r) => r.method);
    expect(methods).toEqual(['POST', 'PATCH', 'PUT', 'PATCH']);
    expect(reqs[2]?.path).toBe('/api/v1/admin/products/p-new');
    expect(reqs[2]?.body).toMatchObject({ expected_updated_at: '2026-10-07T01:00:00.000Z' });
    expect(doneMsgs).toHaveLength(1);
  });

  it('编辑草稿：有「保存」与「保存并上架」；编辑在售：只有「保存」', async () => {
    publishFails = false;
    const draftEl = await openForm({ ...SOURCE, id: 'p-new', status: 'draft' });
    expect(button(draftEl, '保存')).not.toBeNull();
    expect(button(draftEl, '保存并上架')).not.toBeNull();
    // 主按钮每屏只留一个（对标 §238）：上架是主动作（实心），保存降为描边
    expect(button(draftEl, '保存并上架')?.className).toBe('btn');
    expect(button(draftEl, '保存')?.className).toContain('btn-secondary');
    await mounted?.unmount();
    const activeEl = await openForm(SOURCE);
    expect(button(activeEl, '保存')).not.toBeNull();
    expect(button(activeEl, '保存并上架')).toBeNull();
    expect(button(activeEl, '保存')?.className).toBe('btn');
  });

  it('示例占位符都以「例：」开头（验收 2026-10-08：原先像已填好的值）', async () => {
    const el = await openForm(null);
    const examples = ['商品名（面向买家）', '日文品名（采购用）', 'HS 编码'].map(
      (l) => (field(el, l) as HTMLInputElement | null)?.placeholder ?? '',
    );
    for (const p of examples) expect(p.startsWith('例：')).toBe(true);
  });

  it('🔴 买家可见字段的示例用中文（买家端标题是中文；原「資生堂 クレンジングオイル」像是要填日文）；日文品名才用日文示例', async () => {
    const el = await openForm(null);
    const ph = (l: string): string => (field(el, l) as HTMLInputElement | null)?.placeholder ?? '';
    const kana = /[\u3040-\u30ff]/;
    expect(ph('商品名（面向买家）')).not.toMatch(kana);
    expect(ph('商品名（面向买家）')).toContain('资生堂');
    expect(ph('产地 / 工房 / 匠人（买家可见）')).not.toMatch(/伝/);
    expect(ph('日文品名（采购用）')).toMatch(kana);
  });

  it('🔴 没有商品图时状态卡提示（只提示不拦）：上架后买家看到的是占位图；有图或已在售时不提示', async () => {
    // 每开一次先卸掉上一张（同 id 的输入框留在 document 里会让后面的用例聚焦到旧表单上）
    const tip = async (source: Record<string, unknown> | null): Promise<string | undefined> => {
      await mounted?.unmount();
      const el = await openForm(source);
      return [...el.querySelectorAll('.warn')]
        .map((n) => n.textContent ?? '')
        .find((t) => t.includes('商品图'));
    };
    expect(await tip(null)).toContain('占位');
    expect(await tip({ ...SOURCE, status: 'draft' })).toContain('占位');
    const img = { image_id: 'img-1', thumb: 't.jpg', card: 'c.jpg', detail: 'd.jpg' };
    expect(await tip({ ...SOURCE, status: 'draft', images: [img] })).toBeUndefined();
    expect(await tip({ ...SOURCE, status: 'active' })).toBeUndefined();
  });

  it('🔴 分组布局：主栏四组（基本信息 / 媒体 / 价格与库存 / 报关与合规），侧栏有状态（显示「草稿」）与分类', async () => {
    const el = await openForm({ ...SOURCE, status: 'draft' });
    const titles = (sel: string): string[] =>
      [...el.querySelectorAll(`${sel} .form-card-title`)].map((h) => (h.textContent ?? '').trim());
    expect(titles('.product-main')).toEqual(['基本信息', '媒体', '价格与库存', '报关与合规']);
    expect(titles('.product-side')).toEqual(['状态', '分类与标签', '采购']);
    expect(el.querySelector('.product-side')?.textContent).toContain('草稿');
    expect(el.querySelector('.product-side select')).not.toBeNull();
  });
});

describe('商品表单：可切换的标签告诉读屏选没选（全入口点击测试 2026-10-12）', () => {
  it('🔴 合规标签是开关按钮：aria-pressed 跟着选中状态变', async () => {
    const el = await openWith({ ...SOURCE, status: 'draft' });
    const chip = (name: string) =>
      [...el.querySelectorAll('.chips button')].find((b) => b.textContent?.startsWith(name));
    expect(chip('液体')?.getAttribute('aria-pressed')).toBe('false');
    await click(chip('液体'));
    expect(chip('液体')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('商品表单：图片排序与主图（AJ-403）', () => {
  const IMAGES = ['a', 'b', 'c'].map((k) => ({
    image_id: `img-${k}${k}${k}${k}${k}${k}${k}${k}${k}${k}${k}${k}`,
    thumb: `https://img.example.com/${k}/thumb.webp`,
    card: `https://img.example.com/${k}/card.webp`,
    detail: `https://img.example.com/${k}/detail.webp`,
  }));

  const sentIds = (): string[] =>
    (
      (calls.find((c) => c.method === 'PUT')?.body as { images?: Array<{ image_id: string }> })
        ?.images ?? []
    ).map((i) => i.image_id.slice(4, 5));

  it('🔴 第三张「设为主图」→ 保存时 images 顺序为 c, a, b；第一张标「主图」', async () => {
    const el = await openWith({ ...SOURCE, images: IMAGES });
    await click(el.querySelector('[aria-label="把第 3 张设为主图"]'));
    expect(el.querySelector('.thumb')?.textContent).toContain('主图');
    expect(el.querySelector('.thumb img')?.getAttribute('src')).toContain('/c/');
    await click(button(el, '保存'));
    expect(sentIds()).toEqual(['c', 'a', 'b']);
  });

  it('🔴 前移 / 后移：第一张不能再前移、最后一张不能再后移（按钮禁用）；第 2 张前移 → b, a, c', async () => {
    const el = await openWith({ ...SOURCE, images: IMAGES });
    expect(
      (el.querySelector('[aria-label="把第 1 张前移"]') as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    expect(
      (el.querySelector('[aria-label="把第 3 张后移"]') as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    await click(el.querySelector('[aria-label="把第 2 张前移"]'));
    await click(button(el, '保存'));
    expect(sentIds()).toEqual(['b', 'a', 'c']);
  });

  // 全入口点击测试 2026-10-12：图是从左往右排的，按钮却写 ↑ / ↓；缩略图用了 Banner 的 2.5:1 横框，方图被裁成一条；
  // 每个按钮各占一行，三张图的媒体区比整张表单的其它部分还高
  it('🔴 版式：按钮写 ← / →（与图的排列方向一致）、方形缩略图、「移除」用危险色；可一次选多张', async () => {
    const el = await openWith({ ...SOURCE, images: IMAGES });
    const second = [...el.querySelectorAll('.thumb')][1];
    expect(second?.querySelector('[aria-label="把第 2 张前移"]')?.textContent).toBe('←');
    expect(second?.querySelector('[aria-label="把第 2 张后移"]')?.textContent).toBe('→');
    expect(second?.querySelector('img')?.className).toContain('thumb-img-square');
    expect(button(second as HTMLElement, '移除')?.className).toContain('link-danger');
    expect((el.querySelector('input[type="file"]') as HTMLInputElement).multiple).toBe(true);
  });

  it('🔴 一次选两张 → 按选的顺序逐张上传、都加进来；上传期间保存按钮是"图片上传中…"', async () => {
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      const k = String(n);
      return new Response(
        JSON.stringify({
          image_key: `k${k}`,
          image_id: `img-new${k}`,
          thumb: `https://img.example.com/new${k}/thumb.webp`,
          card: `https://img.example.com/new${k}/card.webp`,
          detail: `https://img.example.com/new${k}/detail.webp`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const el = await openWith({ ...SOURCE, images: [] });
      const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
      const f = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', { value: [f('1.png'), f('2.png')] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      await flush();
      const srcs = [...el.querySelectorAll('.thumb img')].map((i) => i.getAttribute('src'));
      expect(srcs).toEqual([
        'https://img.example.com/new1/thumb.webp',
        'https://img.example.com/new2/thumb.webp',
      ]);
      expect(n).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('排序算改动：调了顺序未保存 → 脏（离开要提醒）', async () => {
    const el = await openWithDirty({ ...SOURCE, images: IMAGES });
    expect(dirtyOf(el)).toBe('no');
    await click(el.querySelector('[aria-label="把第 3 张后移"]')); // 禁用：不动
    expect(dirtyOf(el)).toBe('no');
    await click(el.querySelector('[aria-label="把第 2 张后移"]'));
    expect(dirtyOf(el)).toBe('yes');
  });
});

/** AJ-410（新手走查）N22～N26：标签无内部编号、必填统一标记、HS 编码说明、错误清单可点、保存条吸底。 */
describe('商品表单：新手可用性（AJ-410）', () => {
  it('标签里没有「D-39」「MVP」；必填项统一标「*必填」；HS 编码有一行说明', async () => {
    const el = await openWith(null);
    const text = el.textContent ?? '';
    expect(text).not.toMatch(/D-\d+|MVP/);
    const required = [...el.querySelectorAll('.label')]
      .filter((l) => l.querySelector('.required-mark') !== null)
      .map((l) => (l.textContent ?? '').replace(/\s*\*必填$/, ''));
    expect(required).toEqual(
      expect.arrayContaining([
        '商品名（面向买家）',
        '售价（日元）',
        '英文报关品名',
        'HS 编码',
        '分类',
      ]),
    );
    expect(text).toContain('海关商品编码，6–10 位数字，例：3304.99');
  });

  it('🔴 空表单点保存 → 顶部列出要改的字段，点「HS 编码」光标跳到那一格（N26）；保存按钮在吸底条里（N25）', async () => {
    const el = await openWith(null);
    const save = button(el, '保存为草稿');
    expect(save?.closest('.sticky-actions')).not.toBeNull();
    await click(save);
    const list = el.querySelector('[aria-label="需要修正的项"]') as HTMLElement;
    expect(list).not.toBeNull();
    await click(button(list, 'HS 编码'));
    expect(document.activeElement).toBe(field(el, 'HS 编码'));
  });
});

describe('商品表单：返回列表与回车（审查 2026-10-09 #1 / #3）', () => {
  it('🔴 脏表单点「返回列表」→ 先弹「离开这一页会丢掉未保存的修改」，不回列表；点「放弃修改并离开」才回', async () => {
    const el = await openWithDirty(SOURCE);
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    await click(button(el, '返回列表'));
    expect(doneCount).toBe(0);
    expect(el.textContent).toContain('离开这一页会丢掉未保存的修改');
    await click(button(el, '取消'));
    expect(doneCount).toBe(0);
    await click(button(el, '返回列表'));
    await click(button(el, '放弃修改并离开'));
    expect(doneCount).toBe(1);
  });

  it('干净的表单点「返回列表」→ 直接回列表，不弹', async () => {
    const el = await openWithDirty(SOURCE);
    await click(button(el, '返回列表'));
    expect(doneCount).toBe(1);
    expect(el.textContent).not.toContain('离开这一页会丢掉未保存的修改');
  });

  it('🔴 表单的隐式提交（单行框里按回车）不写库、不离开：保存只认页底按钮', async () => {
    const el = await open();
    await typeInto(field(el, '商品名（面向买家）'), '改过的标题');
    const form = el.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((c) => c.method === 'PUT' || c.method === 'POST')).toHaveLength(0);
    expect(doneCount).toBe(0);
    await click(button(el, '保存'));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});
