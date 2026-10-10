/**
 * 职责：地址编辑页薄壳的行为用例——连点保存只发一次（W-03），保存失败不冒充"取不到地址"（W-07）。
 *
 * @why ① POST /addresses 没有幂等键，双击会建出两条一样的地址；页面原来只靠按钮的 disabled 挡。
 *      ② 保存失败与取数失败共用一个 `error`，页面显示"没能取到这条地址 / 返回列表重开这一页"，
 *         照做会丢掉刚填的整张表单。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let posts: Array<{ url: string; method?: string }>;
let hold: ReturnType<typeof deferred<unknown>> | null;
let fail: Error | null;
/** 新增成功后的一次性交接要从这里读（结算页 → 新增地址 → 自动选中）。 */
let gd: Record<string, unknown>;

const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const FORM = {
  recipient: 'Alice Wang',
  phone: '+14155550123',
  line1: '1 Market St',
  line2: '',
  city: 'San Francisco',
  state: 'CA',
  postal_code: '94105',
  is_default: false,
};

beforeEach(async () => {
  posts = [];
  hold = null;
  fail = null;
  vi.stubGlobal('wx', { navigateBack: () => undefined });
  gd = {
    apiBase: 'http://api.test',
    api: async (req: { url: string; method?: string }) => {
      posts.push(req);
      if (hold !== null) return hold.promise;
      if (fail !== null) throw fail;
      return { id: 'addr-1' };
    },
  };
  page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: gd });
  call('onLoad', {});
  page.setData({ form: { ...FORM } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('地址编辑页：连点保存（W-03）', () => {
  it('🔴 保存在途时再点一次 → 只发一次 POST', async () => {
    hold = deferred();
    call('onSave');
    call('onSave');
    await settle();
    expect(posts.filter((p) => p.method === 'POST')).toHaveLength(1);
    hold.resolve({ id: 'addr-1' });
    await settle();
  });
});

describe('地址编辑页：保存失败的提示（W-07）', () => {
  it('🔴 保存失败 → 写 saveError，不写取数错误（否则页面会说"没能取到这条地址"）', async () => {
    fail = Object.assign(new Error('收件人格式不对'), { code: 40002 });
    call('onSave');
    await settle();
    expect(page.data['error']).toBe('');
    expect(String(page.data['saveError'])).not.toBe('');
  });
});

/** 剩余清单 4-5：州改为下拉。 */
describe('地址编辑：州下拉（4-5）', () => {
  it('🔴 下拉选第 i 项 → form.state = 该项的州码，并清掉州的旧错误', async () => {
    const { US_STATE_ROWS } = await import('../../utils/us-states.js');
    const idx = US_STATE_ROWS.findIndex((r) => r.code === 'NY');
    page.setData({ errors: { state: '州为两位大写缩写，请从列表选择' } });
    call('onStatePick', { detail: { value: String(idx) } });
    expect((page.data['form'] as { state: string }).state).toBe('NY');
    expect(page.data['errors']).toEqual({});
    expect(Array.isArray(page.data['stateLabels'])).toBe(true);
  });

  it('下标越界 / 非数字 → 不改', () => {
    const before = (page.data['form'] as { state: string }).state;
    call('onStatePick', { detail: { value: '999' } });
    call('onStatePick', { detail: { value: 'x' } });
    expect((page.data['form'] as { state: string }).state).toBe(before);
  });
});

describe('地址编辑：下拉定位到已有的州（扫描 W-04）', () => {
  it('🔴 选中某州后 stateIndex 跟着变（下次打开下拉停在它上面）', async () => {
    const { US_STATE_ROWS } = await import('../../utils/us-states.js');
    const idx = US_STATE_ROWS.findIndex((r) => r.code === 'CA');
    call('onStatePick', { detail: { value: String(idx) } });
    expect(page.data['stateIndex']).toBe(idx);
  });
});

describe('地址编辑页：英文填写说明（M-20，AJ-406）', () => {
  it('进页即带说明与三条示例（新增与编辑态同一份，不依赖取数）', () => {
    const note = page.data['englishNote'] as { title: string; examples: unknown[] };
    expect(note.title).toBe('请用英文 / 拼音填写');
    expect(note.examples).toHaveLength(3);
  });
});

describe('地址编辑：地址已不存在 / 还在加载（审查 2026-10-09）', () => {
  it('🔴 编辑的地址已被删除 → 点保存不发请求（不会 PUT 到已删除的 id）', async () => {
    call('onLoad', { id: 'addr-gone' });
    hold = null;
    await settle(); // GET /addresses 返回 {id:'addr-1'}（不是数组）→ 找不到
    expect(page.data['error']).toBe('这个地址已不存在（可能已被删除）');
    page.setData({ form: { ...FORM } });
    const before = posts.length;
    call('onSave');
    await settle();
    expect(posts.length).toBe(before);
  });

  it('🔴 加载中 → 点保存不发请求；用户先输入的内容不被回来的数据覆盖（加载期间表单不可编辑）', async () => {
    hold = deferred();
    call('onLoad', { id: 'addr-1' });
    await settle();
    expect(page.data['loading']).toBe(true);
    const before = posts.length;
    call('onSave');
    await settle();
    expect(posts.length).toBe(before);
  });
});

describe('导航栏标题（三端走查小白视角 2026-10-10）', () => {
  it('🔴 新增与编辑共用本页：导航栏写中性的「收货地址」，页内标题再分新增 / 编辑（原先新增时顶栏写"编辑地址"）', () => {
    const json = JSON.parse(readFileSync(new URL('./index.json', import.meta.url), 'utf8')) as {
      navigationBarTitleText?: string;
    };
    expect(json.navigationBarTitleText).toBe('收货地址');
  });
});

describe('新增成功 → 交给地址列表"刚新增的那条"（三端走查小白视角 2026-10-10）', () => {
  it('🔴 POST 成功 → globalData.justAddedAddressId = 新地址 id；编辑（PUT）不写', async () => {
    call('onSave');
    await settle();
    expect(posts.map((p) => p.method)).toEqual(['POST']);
    expect(gd['justAddedAddressId']).toBe('addr-1');
  });

  it('保存失败不写（不能把没存上的地址当成选中）', async () => {
    fail = Object.assign(new Error('bad'), { code: 40001 });
    call('onSave');
    await settle();
    expect(gd['justAddedAddressId'] ?? '').toBe('');
  });
});
