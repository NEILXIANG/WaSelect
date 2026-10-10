/**
 * 职责：地址列表薄壳的行为——从结算页新增地址后自动选中（三端走查小白视角 2026-10-10）。
 *
 * @why 小白从结算页「还没有地址，点这里新增」进来，保存后原先落回地址列表，还得再点一次「用这个地址」；
 *      页面上最显眼的是实心「新增地址」，容易再新增一条。主流电商从结算页新增后直接带回结算页并选中。
 *      交接走一次性 `globalData.justAddedAddressId`（编辑页写、本页 onShow 读走即清），与 `pickedAddressId` 同口径。
 * @see ./index.js；../address-edit/index.js；../../app.js
 */
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
