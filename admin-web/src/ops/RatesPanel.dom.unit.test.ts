// @vitest-environment jsdom
/**
 * 职责：运费分档面板的**组件行为**用例——列表**没加载出来**时，不能让人把一张空表保存成"整表替换"（AJ-232）。
 *
 * @why 保存是整表替换。面板没有"已成功加载"这个状态：首次 GET 失败后表格是空的，
 *      页面却显示"还没有运费档位（所有订单都无法报价）"，而"新增一档 → 保存"全程可用。
 *      运营照提示补录一两档并确认，线上真实的整张运费表就被这一两档覆盖了——
 *      而那条"加载失败"的错误文案在面板最底部。
 *      "档位重复"的标记还按**排序后**的下标对到了**未排序**的表格行上，会标到别的行。
 *
 * @see ./RatesPanel.tsx；./view.ts（`rateDuplicates`）
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
import { RatesPanel } from './RatesPanel.js';

let mounted: Mounted | undefined;
let listFails: boolean;
let list: unknown[];
let puts: Array<{ body?: unknown }>;

async function open(): Promise<HTMLElement> {
  puts = [];
  const api = async (req: { path: string; method?: string; body?: unknown }): Promise<unknown> => {
    if (req.method !== undefined && req.method !== 'GET') {
      puts.push(req);
      return {};
    }
    if (listFails) throw new ApiError(-1, '网络请求失败', '');
    return list;
  };
  mounted = await mount(createElement(RatesPanel, { api: api as never }));
  return mounted.el;
}

const saveButton = (el: HTMLElement): HTMLButtonElement | null => button(el, '保存（整表替换）');

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('运费分档面板：加载失败时不可编辑（AJ-232）', () => {
  it('🔴 加载失败：不说"还没有运费档位"，新增与保存都不可用，给"重新加载"', async () => {
    listFails = true;
    list = [];
    const el = await open();
    expect(el.textContent).not.toContain('还没有运费档位');
    expect(el.textContent).toContain('没有加载出来');
    expect(button(el, '新增一档')?.disabled).toBe(true);
    expect(saveButton(el)?.disabled).toBe(true);
    expect(button(el, '重新加载')).not.toBeNull();
  });

  it('🔴 重新加载成功后才可编辑，且显示的是真实的表', async () => {
    listFails = true;
    list = [{ carrier: 'JP_POST_EMS', max_weight_g: 500, price_jpy: 2950, active: true }];
    const el = await open();
    listFails = false;
    await click(button(el, '重新加载'));
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(button(el, '新增一档')?.disabled).toBe(false);
    expect(button(el, '重新加载')).toBeNull();
  });

  it('加载成功但确实一档都没有：才说"还没有运费档位"，且可以新增', async () => {
    listFails = false;
    list = [];
    const el = await open();
    expect(el.textContent).toContain('还没有运费档位');
    expect(button(el, '新增一档')?.disabled).toBe(false);
  });

  it('🔴 "档位重复"标在**重复的那两行**上，不因为表格没按重量排序而标错行', async () => {
    listFails = false;
    // 表格顺序：2000 / 500 / 500（重复的是后两行）；按重量排序后下标会变成 500 / 500 / 2000
    list = [
      { carrier: 'JP_POST_EMS', max_weight_g: 2000, price_jpy: 4950, active: true },
      { carrier: 'JP_POST_EMS', max_weight_g: 500, price_jpy: 2950, active: true },
      { carrier: 'JP_POST_EMS', max_weight_g: 500, price_jpy: 3000, active: true },
    ];
    const el = await open();
    const flags = [...el.querySelectorAll('tbody tr')].map((tr) =>
      (tr.textContent ?? '').includes('档位重复'),
    );
    expect(flags).toEqual([false, true, true]);
  });
});

describe('运费分档面板：确认替换的在途保护（P2-47）', () => {
  it('🔴 PUT 在途时"确认"按钮禁用，连点只发一次', async () => {
    list = [{ carrier: 'JP_POST_EMS', max_weight_g: 500, price_jpy: 2950, active: true }];
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => {
      release = r;
    });
    let putCount = 0;
    const api = async (req: { method?: string }): Promise<unknown> => {
      if (req.method === 'PUT') {
        putCount += 1;
        await pending;
        return {};
      }
      return list;
    };
    mounted = await mount(createElement(RatesPanel, { api: api as never }));
    const el = mounted.el;
    await click(saveButton(el));
    await click(button(el, '确认：用当前 1 档替换全部'));
    const busy = button(el, '保存中…');
    expect(busy?.disabled).toBe(true);
    await click(busy);
    expect(putCount).toBe(1);
    release();
    await flush();
    expect(el.textContent).toContain('已整表替换');
  });
});
