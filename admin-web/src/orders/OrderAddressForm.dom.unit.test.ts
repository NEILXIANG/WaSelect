// @vitest-environment jsdom
/**
 * 发货前改址（三端联动 UI 模拟 2026-10-08）：改的是"货寄到哪"，一点即生效且无成功提示——改成两步确认。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { button, click, mount, type, type Mounted } from '../testing/dom.js';
import { ApiError } from '../api/errors.js';
import { OrderAddressForm } from './OrderAddressForm.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const ORDER = {
  status: 'paid',
  has_dispute: false,
  address: {
    recipient: 'Kenji Tanaka',
    phone: '+12125550188',
    line1: '20 W 34th St',
    line2: '',
    city: 'New York',
    state: 'NY',
    postal_code: '10001',
    country: 'US',
  },
};

describe('OrderAddressForm', () => {
  it('🔴 点「保存新地址」只进核对态、不发请求；「确认改址」才发，并带回成功提示', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const done: string[] = [];
    mounted = await mount(
      createElement(OrderAddressForm, {
        api: (async (req: { path: string; body?: unknown }) => {
          calls.push(req);
          return {};
        }) as never,
        id: 'o-1',
        order: ORDER as never,
        onDone: (m: string) => done.push(m),
      }),
    );
    const el = mounted.el;
    await type(el.querySelectorAll('input')[2] ?? null, '350 5th Ave');
    await click(button(el, '保存新地址'));
    expect(calls).toHaveLength(0);
    expect(el.textContent).toContain('核对新地址');
    expect(el.textContent).toContain('350 5th Ave');
    await click(button(el, '确认改址'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ line1: '350 5th Ave', city: 'New York' });
    expect(done[0]).toContain('已更新');
  });

  it('核对态下再改字段 → 退出核对（不带着旧核对提交新内容）', async () => {
    mounted = await mount(
      createElement(OrderAddressForm, {
        api: (async () => ({})) as never,
        id: 'o-1',
        order: ORDER as never,
        onDone: () => undefined,
      }),
    );
    const el = mounted.el;
    await click(button(el, '保存新地址'));
    expect(button(el, '确认改址')).not.toBeNull();
    await type(el.querySelectorAll('input')[3] ?? null, 'Apt 5');
    expect(button(el, '确认改址')).toBeNull();
  });

  it('🔴 确认改址时这单已被别人发货（40902）→ 通知页面刷新（onStale），收起核对态', async () => {
    const stale: number[] = [];
    mounted = await mount(
      createElement(OrderAddressForm, {
        api: (async () => {
          throw new ApiError(40902, '订单状态不允许此操作', 'tr-x');
        }) as never,
        id: 'o-1',
        order: ORDER as never,
        onDone: () => undefined,
        onStale: (traceId: string | undefined) => stale.push(traceId === 'tr-x' ? 1 : 0),
      }),
    );
    const el = mounted.el;
    await click(button(el, '保存新地址'));
    await click(button(el, '确认改址'));
    expect(stale).toEqual([1]);
    expect(button(el, '确认改址')).toBeNull();
  });
});
