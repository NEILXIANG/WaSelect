/**
 * 职责：地址列表薄壳的行为——从结算页新增地址后自动选中（三端走查小白视角 2026-10-10）。
 *
 * @why 小白从结算页「还没有地址，点这里新增」进来，保存后原先落回地址列表，还得再点一次「用这个地址」；
 *      页面上最显眼的是实心「新增地址」，容易再新增一条。主流电商从结算页新增后直接带回结算页并选中。
 *      交接走一次性 `globalData.justAddedAddressId`（编辑页写、本页 onShow 读走即清），与 `pickedAddressId` 同口径。
 * @see ./index.js；../address-edit/index.js；../../app.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let gd: Record<string, unknown>;
let calls: string[];

const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  calls = [];
  vi.stubGlobal('wx', {
    navigateBack: () => calls.push('back'),
    navigateTo: (o: { url: string }) => calls.push(`to ${o.url}`),
  });
  gd = {
    apiBase: 'http://api.test',
    pickedAddressId: '',
    justAddedAddressId: '',
    api: async (req: { url: string }) => {
      calls.push(`GET ${req.url.replace('http://api.test', '')}`);
      return [];
    },
  };
  page = await loadPage(new URL('./index.js', import.meta.url).href, { globalData: gd });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('地址列表：从结算页新增后自动选中', () => {
  it('🔴 选择模式 + 刚新增了一条 → 直接选中它并返回结算页，不再取列表；交接值读走即清', async () => {
    call('onLoad', { pick: '1' });
    gd['justAddedAddressId'] = 'addr-new';
    call('onShow');
    await settle();
    expect(gd['pickedAddressId']).toBe('addr-new');
    expect(gd['justAddedAddressId']).toBe('');
    expect(calls).toEqual(['back']);
  });

  it('非选择模式（从「我的」进来管理地址）→ 只清掉交接值，照常取列表、不返回', async () => {
    call('onLoad', {});
    gd['justAddedAddressId'] = 'addr-new';
    call('onShow');
    await settle();
    expect(gd['pickedAddressId']).toBe('');
    expect(gd['justAddedAddressId']).toBe('');
    expect(calls).toEqual(['GET /api/v1/addresses']);
  });

  it('选择模式但没有新增（编辑 / 直接返回）→ 照常取列表', async () => {
    call('onLoad', { pick: '1' });
    call('onShow');
    await settle();
    expect(calls).toEqual(['GET /api/v1/addresses']);
  });
});

// 全入口点击测试 2026-10-11：「新增地址」排在列表最后（20 个地址要滑到底）、选择模式要在四个小字里找「用这个地址」。
// 主流（微信 / 京东）：新增按钮固定在底部；选择模式点整张卡即选中、只留「编辑」；管理模式点卡进编辑
describe('地址列表：整卡可点、新增固定在底部（全入口点击测试 2026-10-11）', () => {
  const tapCard = (id: string) => ({ currentTarget: { dataset: { id } } });

  it('🔴 选择模式点整张卡 → 选中并返回结算页', () => {
    call('onLoad', { pick: '1' });
    call('onCardTap', tapCard('addr-2'));
    expect(gd['pickedAddressId']).toBe('addr-2');
    expect(calls).toEqual(['back']);
  });

  it('🔴 管理模式点整张卡 → 进编辑页', () => {
    call('onLoad', {});
    call('onCardTap', tapCard('addr-2'));
    expect(gd['pickedAddressId']).toBe('');
    expect(calls).toEqual(['to /pages/address-edit/index?id=addr-2']);
  });

  it('🔴 结构：新增按钮在底部固定栏里；卡片绑 onCardTap，卡内动作用 catchtap（不连带触发整卡）；选择模式不出删除 / 设默认', () => {
    const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    expect(wxml).toMatch(/<view class="ws-page ws-page--with-buybar"/);
    // 两端逐页走查第三轮 2026-10-12：账号受限（errorContact）时不出新增按钮——点进去填完也存不上
    expect(wxml).toMatch(
      /<view class="ws-buybar" wx:if="\{\{!errorContact\}\}">[\s\S]*bindtap="onAdd"[\s\S]*<\/view>/,
    );
    expect(wxml).toMatch(/class="ws-card addr[^"]*"[^>]*bindtap="onCardTap"/);
    expect(wxml).not.toMatch(/bindtap="on(Edit|Delete|SetDefault)"/);
    expect(wxml).toMatch(
      /wx:if="\{\{!pick\}\}"[^>]*catchtap="onDelete"|catchtap="onDelete"[^>]*wx:if="\{\{!pick\}\}"/,
    );
  });
});

// 独立审查 2026-10-13 【1】：删除 / 设为默认原先没有在途守卫——连点删除第二次打到已删 id 显示"地址还在"，
// 对两行快速连点"设为默认"发出并发 PUT、最终默认可能不是最后点的那个。
describe('地址列表：删除 / 设为默认的在途守卫', () => {
  const tap = (id: string) => ({ currentTarget: { dataset: { id } } });
  it('🔴 请求在途时再点（同一行或别的行）不再发第二个请求；回来后守卫释放', async () => {
    let release: (() => void) | null = null;
    const sent: string[] = [];
    gd['api'] = (req: { url: string; method?: string }) => {
      sent.push(`${req.method ?? 'GET'} ${req.url.replace('http://api.test', '')}`);
      if (req.method === 'PUT' || req.method === 'DELETE')
        return new Promise<unknown>((r) => {
          release = () => r({});
        });
      return Promise.resolve([
        {
          id: 'a-1',
          recipient: 'A',
          phone: '+14155550101',
          line1: '1 St',
          city: 'SF',
          state: 'CA',
          postal_code: '94102',
          country: 'US',
          is_default: false,
        },
        {
          id: 'a-2',
          recipient: 'B',
          phone: '+14155550102',
          line1: '2 St',
          city: 'SF',
          state: 'CA',
          postal_code: '94103',
          country: 'US',
          is_default: false,
        },
      ]);
    };
    call('onLoad', {});
    call('onShow');
    await settle();
    void call('onSetDefault', tap('a-1'));
    void call('onSetDefault', tap('a-2'));
    void call('removeAddress', 'a-2');
    await settle();
    expect(sent.filter((s) => s.startsWith('PUT') || s.startsWith('DELETE'))).toEqual([
      'PUT /api/v1/addresses/a-1',
    ]);
    expect(page.data['busyId']).toBe('a-1');
    (release as unknown as () => void)();
    await settle();
    expect(page.data['busyId']).toBe('');
  });
});
