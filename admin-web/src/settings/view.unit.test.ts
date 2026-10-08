/**
 * 职责：设置页的呈现规则（AJ-404）——每一项叫什么、值怎么显示、"改它要怎么生效"怎么说。
 *
 * @why 值的显示要把三种"空"分开：未配置（null）、在别的页面看（edit_page）、配置为假（false）。
 *      三者都显示成"—"的话，运营分不清"邮件没配"与"邮件配了但这里不显示"。
 */
import { describe, expect, it } from 'vitest';
import { applyText, groupTitle, itemLabel, valueText } from './view.js';

describe('itemLabel / groupTitle', () => {
  it('已知项给中文名；服务端新加的未知项原样显示 key（不吞掉）', () => {
    expect(itemLabel('seller_name')).toBe('商家名称');
    expect(itemLabel('brand_new_item')).toBe('brand_new_item');
    expect(groupTitle('notify')).toBe('通知');
    expect(groupTitle('zzz')).toBe('zzz');
  });
});

describe('valueText', () => {
  it('null → 未配置；edit_page → 指向运营配置页', () => {
    expect(valueText({ key: 'seller_address', value: null, source: 'env', apply: 'restart' })).toBe(
      '未配置',
    );
    expect(
      valueText({
        key: 'shipping_rates',
        value: null,
        source: 'db',
        apply: 'immediate',
        edit_page: 'ops',
      }),
    ).toBe('在「运营配置」页查看与修改');
  });

  it('布尔 → 已配置 / 未配置；数字原样；数组用顿号连', () => {
    expect(
      valueText({ key: 'mail_configured', value: true, source: 'env', apply: 'restart' }),
    ).toBe('已配置');
    expect(
      valueText({ key: 'sentry_configured', value: false, source: 'env', apply: 'restart' }),
    ).toBe('未配置');
    expect(
      valueText({ key: 'packaging_weight_g', value: 250, source: 'env', apply: 'restart' }),
    ).toBe('250');
    expect(
      valueText({
        key: 'display_currencies',
        value: ['USD', 'CNY'],
        source: 'env',
        apply: 'restart',
      }),
    ).toBe('USD、CNY');
  });

  it('支付通道：开放 / 仅存量、优先级、币种、属性来源', () => {
    expect(
      valueText({
        key: 'payment_channels',
        value: [
          {
            channel: 'stripe',
            enabled: true,
            priority: 20,
            label: '银行卡',
            countries: ['*'],
            currencies: ['USD'],
            attrs_source: 'table',
          },
          {
            channel: 'mock',
            enabled: false,
            priority: 90,
            label: '模拟支付',
            countries: ['*'],
            currencies: ['JPY'],
            attrs_source: 'builtin',
          },
        ],
        source: 'env',
        apply: 'restart',
      }),
    ).toBe(
      '银行卡（stripe）· 开放新单 · 优先级 20 · USD · 属性来自配置表；' +
        '模拟支付（mock）· 仅处理存量订单 · 优先级 90 · JPY · 属性来自内置默认',
    );
  });

  it('关税率：产地→目的国 百分比（NUMERIC 字符串，不经浮点乘法）', () => {
    expect(
      valueText({
        key: 'duty_rates',
        value: [{ origin: 'JP', dest: 'US', rate: '0.15000' }],
        source: 'db',
        apply: 'immediate',
      }),
    ).toBe('JP → US：15%');
    expect(
      valueText({
        key: 'duty_rates',
        value: [{ origin: 'JP', dest: 'US', rate: '0.13040' }],
        source: 'db',
        apply: 'immediate',
      }),
    ).toBe('JP → US：13.04%');
    expect(valueText({ key: 'duty_rates', value: [], source: 'db', apply: 'immediate' })).toBe(
      '未配置',
    );
  });

  it('汇率缓冲按百分比显示', () => {
    expect(
      valueText({ key: 'fx_buffer_rate', value: 0.035, source: 'env', apply: 'restart' }),
    ).toBe('3.5%');
  });
});

describe('applyText', () => {
  it('env：变量名 + 改后需重启；不带 env 名的（密钥类）只说"部署环境变量"', () => {
    expect(
      applyText({ key: 'x', value: 1, source: 'env', apply: 'restart', env: 'PACKAGING_WEIGHT_G' }),
    ).toBe('环境变量 PACKAGING_WEIGHT_G · 改后需重启');
    expect(
      applyText({ key: 'mail_configured', value: true, source: 'env', apply: 'restart' }),
    ).toBe('部署环境变量 · 改后需重启');
  });
  it('db：立即生效 / 需重启', () => {
    expect(applyText({ key: 'x', value: null, source: 'db', apply: 'immediate' })).toBe(
      '数据库 · 立即生效',
    );
    expect(applyText({ key: 'x', value: null, source: 'db', apply: 'restart' })).toBe(
      '数据库 · 改后需重启',
    );
  });
});
