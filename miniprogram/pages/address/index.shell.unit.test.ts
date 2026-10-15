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
import { deferred, loadPage, type LoadedPage } from '../../../test/helpers/mp-page.js';

let page: LoadedPage;
let gd: Record<string, unknown>;
let calls: string[];

const call = (name: string, ...args: unknown[]): unknown =>
  (page[name] as (...a: unknown[]) => unknown)(...args);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
/** 列表里现在有哪些地址 id（渲染行是 vm `addressRows` 的输出）。 */
const rowIds = (): string[] => (page.data['rows'] as Array<{ id: string }>).map((r) => r.id);

/** 一条完整的 `Address`（缺字段的条目 vm 会丢掉，看不出是本用例的问题）。 */
const addr = (id: string, recipient: string): Record<string, unknown> => ({
  id,
  recipient,
  phone: '+14155550101',
  line1: '1 St',
  city: 'SF',
  state: 'CA',
  postal_code: '94102',
  country: 'US',
  is_default: false,
});

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

// UX-003（AJ-555）核实结论：**不改**——`utils/wx-api.ts` 的 ITX-01 已在共享层做掉
// "同一地址 600ms 内只跳一次"（`miniprogram/utils/wx-api.unit.test.ts` 有对应用例）。
// 这里再加 `acceptAddTap` 就是同一条规则的第二份实现（约束九 / H7），且在页面里引 detail 的 vm
// 会凭空多出一条跨页依赖。下面只钉住"本页确实走的是 wxApi.navigateTo（即 ITX-01 覆盖得到）"。
describe('地址列表：新增按钮只走统一跳转口（UX-003 / AJ-555 核实）', () => {
  it('🔴 连点两下「新增地址」→ 只进一次编辑页（由 wx-api ITX-01 拦，本页不另加守卫）', () => {
    call('onLoad', {});
    call('onAdd');
    call('onAdd');
    expect(calls.filter((c) => c.startsWith('to '))).toEqual(['to /pages/address-edit/index']);
  });
});

// UX-008（AJ-556）：`load()` 不领号，删除 / 设默认后 `await this.load()` 会与 onShow 那一次并发，
// 先发后到的旧响应把已删地址再画回来。
describe('地址列表：取数序号（UX-008 / AJ-556）', () => {
  it('🔴 先发的慢响应回来时不覆盖后发的快响应', async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    let n = 0;
    gd['api'] = () => (n++ === 0 ? slow.promise : fast.promise);
    call('onLoad', {});
    void call('onShow');
    await settle();
    void call('onShow');
    await settle();
    fast.resolve([addr('a-new', '新地址')]);
    await settle();
    expect(rowIds()).toEqual(['a-new']);
    // 慢的那一份现在才回来：它比 `fast` 早发出，序号更旧 → 丢弃
    slow.resolve([addr('a-old', '旧地址')]);
    await settle();
    expect(rowIds()).toEqual(['a-new']);
  });

  it('🔴 页面已销毁（onUnload）→ 在途响应回来不改页面', async () => {
    const held = deferred<unknown>();
    gd['api'] = () => held.promise;
    call('onLoad', {});
    void call('onShow');
    await settle();
    expect(page.data['loading']).toBe(true);
    call('onUnload');
    held.resolve([addr('a-1', 'A')]);
    await settle();
    expect(rowIds()).toEqual([]);
    expect(page.data['loading']).toBe(true); // 连 loading 也不再翻（页面已经不在了）
  });

  // ⚠️ 这条是本次改动最可能引入新 bug 的地方：序号机制一旦把"删除后重取"判成过期，
  //    删完地址列表就永远不刷新——所以必须钉住"重取照常生效"。
  it('🔴 删除成功后 `await this.load()` 仍然刷新（序号不得把这条路径判成过期）', async () => {
    let list: unknown[] = [addr('a-1', 'A'), addr('a-2', 'B')];
    gd['api'] = async (req: { method?: string }) => {
      if (req.method === 'DELETE') return {};
      return list;
    };
    call('onLoad', {});
    call('onShow');
    await settle();
    expect(rowIds()).toEqual(['a-1', 'a-2']);
    list = [addr('a-1', 'A')];
    await call('removeAddress', 'a-2');
    await settle();
    expect(rowIds()).toEqual(['a-1']);
    expect(page.data['busyId']).toBe('');
  });

  it('🔴 删除重取在途时，更早发出的那次慢响应回来也不覆盖新列表', async () => {
    const slow = deferred<unknown>();
    let list: unknown[] = [addr('a-1', 'A'), addr('a-2', 'B')];
    let n = 0;
    gd['api'] = (req: { method?: string }) => {
      if (req.method === 'DELETE') return Promise.resolve({});
      // 第 1 次（onShow 那一次）挂住；第 2 次（删除后重取）立刻回新列表
      return n++ === 0 ? slow.promise : Promise.resolve(list);
    };
    call('onLoad', {});
    void call('onShow');
    await settle();
    list = [addr('a-1', 'A')];
    await call('removeAddress', 'a-2');
    await settle();
    expect(rowIds()).toEqual(['a-1']);
    slow.resolve([addr('a-1', 'A'), addr('a-2', 'B')]);
    await settle();
    expect(rowIds()).toEqual(['a-1']); // 旧响应不能把已删地址画回来
  });
});
