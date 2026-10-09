// @vitest-environment jsdom
/**
 * 职责：列表共用控件（评估 4.5 / 4.6）——排序表头与每页条数的行为。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { click, mount, type Mounted } from '../testing/dom.js';
import { PageSizeSelect, readListParams, SortTh } from './list-controls.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const KEYS = ['created_at', 'total_jpy'] as const;

describe('readListParams', () => {
  it('🔴 读出排序与条数；认不出的值回落默认（不把坏参数发给服务端）', () => {
    expect(readListParams(new URLSearchParams('sort=-total_jpy&size=50'), KEYS)).toEqual({
      sortKey: 'total_jpy',
      sortDir: 'desc',
      size: 50,
    });
    expect(readListParams(new URLSearchParams('sort=stock&size=37'), KEYS)).toEqual({
      sortKey: null,
      sortDir: 'desc',
      size: 20,
    });
    expect(readListParams(new URLSearchParams(''), KEYS)).toEqual({
      sortKey: null,
      sortDir: 'desc',
      size: 20,
    });
  });
});

describe('SortTh', () => {
  async function th(currentKey: string | null, currentDir: 'asc' | 'desc') {
    const got: string[] = [];
    mounted = await mount(
      createElement(
        'table',
        null,
        createElement(
          'thead',
          null,
          createElement(
            'tr',
            null,
            createElement(SortTh, {
              label: '金额',
              sortKey: 'total_jpy',
              currentKey,
              currentDir,
              onSort: (s: string) => got.push(s),
            }),
          ),
        ),
      ),
    );
    return { el: mounted.el, got };
  }

  it('🔴 非当前列：aria-sort=none，点了 → 降序；当前降序 → 点了升序，aria-sort=descending', async () => {
    const a = await th('created_at', 'desc');
    expect(a.el.querySelector('th')?.getAttribute('aria-sort')).toBe('none');
    await click(a.el.querySelector('button'));
    expect(a.got).toEqual(['-total_jpy']);
    await mounted?.unmount();
    const b = await th('total_jpy', 'desc');
    expect(b.el.querySelector('th')?.getAttribute('aria-sort')).toBe('descending');
    await click(b.el.querySelector('button'));
    expect(b.got).toEqual(['total_jpy']);
  });
});

describe('PageSizeSelect', () => {
  it('只给 20 / 50 / 100；选了回调数字', async () => {
    const got: number[] = [];
    mounted = await mount(
      createElement(PageSizeSelect, { size: 20, onChange: (n) => got.push(n) }),
    );
    const sel = mounted.el.querySelector('select') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['20', '50', '100']);
    sel.value = '50';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(got).toEqual([50]);
  });
});
