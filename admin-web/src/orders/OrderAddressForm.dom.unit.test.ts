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

  // 两端输入测试 2026-10-12：输入框不限长，收件人贴 101 个字 → 服务端 40001，页面只弹"改址失败"+技术编号（小程序早有 maxlength）
  it('🔴 每格限长与列宽一致（收件人 100、电话 20、地址 200、城市 100、州 2、邮编 10）', async () => {
    mounted = await mount(
      createElement(OrderAddressForm, {
        api: (async () => ({})) as never,
        id: 'o-1',
        order: ORDER as never,
        onDone: () => undefined,
      }),
    );
    const max = Object.fromEntries(
      [...mounted.el.querySelectorAll('input')].map((i) => [i.id, i.maxLength]),
    );
    expect(max).toEqual({
      'addr-recipient': 100,
      'addr-phone': 20,
      'addr-line1': 200,
      'addr-line2': 200,
      'addr-city': 100,
      'addr-state': 2,
      'addr-postal_code': 10,
    });
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

  // AJ-498：服务端 40002 带 {field, reason}——说清是哪一格、什么原因，不再是通用的"地址须为英文/拼音或电话格式错误"；
  // 填写问题不是技术故障，不给报障编号（同分类重名 4ef8991）
  it('🔴 服务端说邮编与州对不上（40002 zip_state_mismatch）→ 提示"邮编和州对不上"，不给报障编号', async () => {
    mounted = await mount(
      createElement(OrderAddressForm, {
        api: (async () => {
          throw new ApiError(40002, '地址须为英文/拼音或电话格式错误', 'tr-z', {
            data: { field: 'postal_code', reason: 'zip_state_mismatch' },
          });
        }) as never,
        id: 'o-1',
        order: ORDER as never,
        onDone: () => undefined,
      }),
    );
    const el = mounted.el;
    await click(button(el, '保存新地址'));
    await click(button(el, '确认改址'));
    expect(el.textContent).toContain('邮编和州对不上：请检查州或邮编');
    expect(el.textContent).not.toContain('须为英文');
    expect(el.textContent).not.toContain('发给技术人员');
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
