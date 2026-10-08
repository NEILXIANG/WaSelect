// @vitest-environment jsdom
/**
 * 职责：「导出所选」与「打印拣货单与面单信息」（AJ-407）的组件接线——勾两单 → 请求带的是这两单的 order_id；
 *       打印页拉两单详情、渲染拣货与面单字段、抬头写明不是承运商面单。
 * @why 纯函数（print-view.unit.test.ts）全绿也可能接错线：导出没带 order_ids（= 导出全部）、
 *      打印拉的是列表缓存而不是详情（没有地址与申报价）——这些只在组件层看得见。
 * @see ./OrdersPage.tsx；./SelectionBar.tsx；./PrintSheet.tsx
 */
import { createElement, useCallback, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, mount, type Mounted } from '../testing/dom.js';
import { OrdersPage } from './OrdersPage.js';
import { parseHash, type Route } from '../router.js';

let mounted: Mounted | undefined;
let paths: string[];

const BASE = { status: 'paid', total_jpy: 13750, created_at: '2026-10-07T01:00:00Z' };
const LIST = [
  { ...BASE, order_id: 'ord_a', order_no: '261007-7K3QXA' },
  { ...BASE, order_id: 'ord_b', order_no: '261007-8M2WRD' },
  { ...BASE, order_id: 'ord_c', order_no: '261007-9P4TZE' },
];
const DETAIL: Record<string, unknown> = {
  ord_a: {
    ...LIST[0],
    address: {
      recipient: 'Jane Doe',
      phone: '+14155550123',
      line1: '1 Infinite Loop',
      city: 'Cupertino',
      state: 'CA',
      postal_code: '95014',
      country: 'US',
    },
    items: [
      {
        title: 'Deba Knife 出刃包丁',
        qty: 1,
        title_ja: '出刃包丁 165mm',
        jan_code: '4900000000011',
        purchase_source: '堺 刃物店',
        hs_code: '8211.91',
        customs_desc_en: 'Kitchen knife, stainless',
        declared_value_usd: 8576,
        weight_g: 540,
      },
    ],
  },
  ord_b: {
    ...LIST[1],
    address: {
      recipient: 'John Smith',
      phone: '+12125550188',
      line1: '350 5th Ave',
      line2: 'Fl 34',
      city: 'New York',
      state: 'NY',
      postal_code: '10118',
      country: 'US',
    },
    items: [
      {
        title: 'Matcha 抹茶 40g',
        qty: 2,
        title_ja: '抹茶 40g 缶',
        jan_code: '4900000000028',
        purchase_source: '宇治 茶舗',
        hs_code: '0902.10',
        customs_desc_en: 'Green tea powder',
        declared_value_usd: 2400,
        weight_g: 120,
      },
    ],
  },
};

function Harness({ initial }: { initial: Route }): React.JSX.Element {
  const [route, setRoute] = useState<Route>(initial);
  const onNavigate = useCallback((next: Route) => setRoute(next), []);
  const api = (req: { path: string }): Promise<unknown> => {
    paths.push(req.path);
    if (req.path.startsWith('/api/v1/admin/exports/')) {
      return Promise.resolve({ filename: 'customs-20261008.csv', csv: '﻿a\r\n' });
    }
    const m = /^\/api\/v1\/admin\/orders\/([^?/]+)$/.exec(req.path);
    if (m !== null) return Promise.resolve(DETAIL[decodeURIComponent(m[1] ?? '')]);
    return Promise.resolve({ items: LIST, total: LIST.length });
  };
  return createElement(OrdersPage, { api: api as never, route, onNavigate });
}

async function open(hash: string): Promise<HTMLElement> {
  paths = [];
  mounted = await mount(createElement(Harness, { initial: parseHash(hash) }));
  return mounted.el;
}

async function pickTwo(el: HTMLElement): Promise<void> {
  await click(el.querySelector('input[aria-label="选择 261007-7K3QXA"]'));
  await click(el.querySelector('input[aria-label="选择 261007-8M2WRD"]'));
}

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('导出所选 / 打印（AJ-407）', () => {
  it('🔴 「全部」页签勾两单 → 导出所选（报关）请求带这两单的 order_id', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => undefined,
    });
    const el = await open('#/orders');
    await pickTwo(el);
    expect(el.textContent).toContain('已选 2 单');
    await click(button(el, '导出所选（报关）'));
    expect(paths.filter((p) => p.includes('/exports/'))).toEqual([
      '/api/v1/admin/exports/customs?order_ids=ord_a,ord_b',
    ]);
    expect(el.querySelector('.toast')?.textContent).toContain('已导出');
  });

  it('🔴 勾两单 → 打印页拉两单详情，渲染拣货（日文原名 / JAN / 采购来源 / 数量）与面单信息（地址 / 电话 / HS / 申报价）', async () => {
    const prints: number[] = [];
    vi.stubGlobal('print', () => prints.push(1));
    const el = await open('#/orders?status=paid');
    await pickTwo(el);
    await click(button(el, '打印拣货单与面单信息（2）'));
    await flush();
    expect(paths).toContain('/api/v1/admin/orders/ord_a');
    expect(paths).toContain('/api/v1/admin/orders/ord_b');
    expect(el.textContent).toContain('不是承运商面单');
    const a = el.querySelector('[aria-label="打印 261007-7K3QXA"]')?.textContent ?? '';
    const b = el.querySelector('[aria-label="打印 261007-8M2WRD"]')?.textContent ?? '';
    for (const s of [
      '出刃包丁 165mm',
      '4900000000011',
      '堺 刃物店',
      'Jane Doe',
      'Cupertino, CA 95014',
    ]) {
      expect(a).toContain(s);
    }
    expect(a).toContain('+1 (415) 555-0123');
    expect(a).toContain('8211.91');
    expect(a).toContain('Kitchen knife, stainless');
    expect(a).toContain('$85.76');
    for (const s of [
      '抹茶 40g 缶',
      '宇治 茶舗',
      'Fl 34',
      '+1 (212) 555-0188',
      '0902.10',
      '$24.00',
    ]) {
      expect(b).toContain(s);
    }
    expect(a).not.toContain('John Smith'); // 两单不串
    await click(button(el, '打印'));
    expect(prints).toHaveLength(1);
    await click(button(el, '返回列表'));
    expect(el.textContent).toContain('订单管理');
  });
});
