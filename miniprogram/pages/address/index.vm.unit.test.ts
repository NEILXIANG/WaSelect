/**
 * 职责：地址列表页 vm 的单测（约束十一要求的配套测试；`vm-guard` 会检查它存在）。
 *
 * @why 钉的是"看起来能用、实际是坏的"：
 *      ① 没 id 的条目渲染成点不动的行（点了发 `/addresses/undefined`）；
 *      ② 空的空态开关在**请求失败**时也亮 → 用户以为自己没存过地址（说假话）。
 */
import { describe, expect, it } from 'vitest';
import { addressRows, emptyState } from './index.vm.js';

const LIST = [
  {
    id: 'addr-1',
    recipient: 'Ken Tanaka',
    phone: '+14155550123',
    line1: '1234 Market St',
    line2: '',
    city: 'San Francisco',
    state: 'CA',
    postal_code: '94102',
    country: 'US',
    is_default: true,
  },
  {
    id: 'addr-2',
    recipient: 'Ayumi Sato',
    phone: '+12125550142',
    line1: '77 Bleecker St',
    line2: 'Apt 3',
    city: 'New York',
    state: 'ny',
    postal_code: '10012',
    country: 'US',
    is_default: false,
  },
];

describe('addressRows（列表行）', () => {
  it('字段透传 + 摘要（region 由 address-form 拼，这里不重拼）', () => {
    const [row] = addressRows(LIST);
    expect(row).toEqual({
      id: 'addr-1',
      recipient: 'Ken Tanaka',
      phone: '+14155550123',
      line1: '1234 Market St',
      line2: '',
      region: 'San Francisco, CA, 94102',
      isDefault: true,
      defaultText: '默认',
    });
  });

  it('非默认地址 → defaultText 为空串（不是 undefined，wxml 里会渲染成 "undefined"）', () => {
    expect(addressRows(LIST)[1]?.defaultText).toBe('');
    expect(addressRows(LIST)[1]?.isDefault).toBe(false);
  });

  it('⚠️ 没有 id 的条目被丢掉——点了会打到 /addresses/undefined', () => {
    expect(addressRows([{ recipient: 'No Id' }, ...LIST])).toHaveLength(2);
    expect(addressRows([{ id: '' }])).toEqual([]);
  });

  it('脏输入：null / 非数组 / 元素非对象 → 空数组，不抛', () => {
    expect(addressRows(null)).toEqual([]);
    expect(addressRows('x')).toEqual([]);
    expect(addressRows([null, 42, { id: 'addr-1' }])).toHaveLength(1);
  });

  it('⚠️ 缺 city 的条目仍能渲染，region 里不出现双逗号', () => {
    const row = addressRows([{ ...LIST[0], city: '' }])[0];
    expect(row?.region).toBe('CA, 94102');
    expect(row?.region).not.toMatch(/,{2}/);
  });
});

describe('emptyState（空态开关）', () => {
  it('有地址 / 有错误 → 都不显示空态', () => {
    expect(emptyState(addressRows(LIST), '').showEmpty).toBe(false);
    expect(emptyState([], '网络请求失败').showEmpty).toBe(false);
  });

  it('⚠️ 请求失败时不说"还没有地址"（那是在说假话）', () => {
    // @why 用户会以为自己没存过，于是再存一遍 → 两条一样的地址。
    expect(emptyState([], 'error').showEmpty).toBe(false);
    expect(emptyState([], '').showEmpty).toBe(true);
  });
});
