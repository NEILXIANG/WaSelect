/**
 * 职责：地址编辑页薄壳的行为用例——连点保存只发一次（W-03），保存失败不冒充"取不到地址"（W-07）。
 *
 * @why ① POST /addresses 没有幂等键，双击会建出两条一样的地址；页面原来只靠按钮的 disabled 挡。
 *      ② 保存失败与取数失败共用一个 `error`，页面显示"没能取到这条地址 / 返回列表重开这一页"，
 *         照做会丢掉刚填的整张表单。
 * @see ../../../test/helpers/mp-page.ts；./index.js
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let posts: Array<{ url: string; method?: string }>;
let hold: ReturnType<typeof deferred<unknown>> | null;
let fail: Error | null;

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
  page = await loadPage(new URL('./index.js', import.meta.url).href, {
    globalData: {
      apiBase: 'http://api.test',
      api: async (req: { url: string; method?: string }) => {
        posts.push(req);
        if (hold !== null) return hold.promise;
        if (fail !== null) throw fail;
        return { id: 'addr-1' };
      },
    },
  });
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
