/**
 * 职责：支付通道代号 → 中文名（全入口点击测试 2026-10-11）。
 * @why 订单详情原写"mock · 13,680 円"、时间线"支付机构 mock"——通道代号运营读不懂；
 *      中文名取设置接口里的 payment_channels（与买家支付页同一份配置），不在前端写死（约束四）。
 */
import { describe, expect, it } from 'vitest';
import { channelLabelsFrom } from './channel-labels.js';
import { eventActorText, paymentSummary } from './view.js';

const SETTINGS = {
  groups: [
    { key: 'shop', items: [{ key: 'shop_name', value: 'WaSelect' }] },
    {
      key: 'payment',
      items: [
        {
          key: 'payment_channels',
          value: [
            { channel: 'mock', label: '模拟支付', enabled: true },
            { channel: 'stripe', label: '银行卡', enabled: true },
          ],
        },
      ],
    },
  ],
};

describe('channelLabelsFrom', () => {
  it('🔴 从设置接口的 payment_channels 取 代号 → 中文名', () => {
    expect(channelLabelsFrom(SETTINGS as never)).toEqual({ mock: '模拟支付', stripe: '银行卡' });
  });
  it('形状不对 / 没有这一组 → 空表（调用方原样显示代号）', () => {
    expect(channelLabelsFrom({ groups: [] })).toEqual({});
    expect(channelLabelsFrom(null as never)).toEqual({});
  });
});

describe('带中文名的支付信息与操作者', () => {
  const labels = { mock: '模拟支付', stripe: '银行卡' };
  it('🔴 支付一行写中文名', () => {
    expect(
      paymentSummary(
        { payment: { channel: 'mock', charge_currency: 'JPY', charge_amount: 13680 } },
        labels,
      ),
    ).toBe('模拟支付 · 13,680 日元');
  });
  it('🔴 时间线操作者写「支付机构 中文名」', () => {
    expect(eventActorText({ actor: 'provider:stripe' }, labels)).toBe('支付机构 银行卡');
  });
  it('认不出的通道 → 原样显示代号（不吞信息）', () => {
    expect(eventActorText({ actor: 'provider:wechat' }, labels)).toBe('支付机构 wechat');
  });
});
