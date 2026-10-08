/**
 * 职责：设置页的呈现规则（AJ-404）——每一项叫什么、值怎么显示、"改它要怎么生效"怎么说。
 *
 * @why 值的显示要把三种"空"分开：未配置（null）、在别的页面看（edit_page）、配置为假（false）。
 *      三者都显示成"—"的话，运营分不清"邮件没配"与"邮件配了但这里不显示"。
 */
import { describe, expect, it } from 'vitest';
import { applyText, groupTitle, itemLabel, valueText, NOT_SET, techText } from './view.js';

describe('itemLabel / groupTitle', () => {
  it('已知项给中文名；服务端新加的未知项原样显示 key（不吞掉）', () => {
    expect(itemLabel('seller_name')).toBe('商家名称');
    expect(itemLabel('brand_new_item')).toBe('brand_new_item');
    expect(groupTitle('notify')).toBe('通知');
    expect(groupTitle('zzz')).toBe('zzz');
  });
});

describe('valueText', () => {
  // AJ-410 / N31：「未配置」改为告诉运营下一步（找技术人员）
  it('null → 未填写（请技术人员配置）；edit_page → 指向运营配置页', () => {
    expect(valueText({ key: 'seller_address', value: null, source: 'env', apply: 'restart' })).toBe(
      NOT_SET,
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

  it('布尔 → 已开通 / 未开通；数字原样；数组用顿号连', () => {
    expect(
      valueText({ key: 'mail_configured', value: true, source: 'env', apply: 'restart' }),
    ).toBe('已开通');
    expect(
      valueText({ key: 'sentry_configured', value: false, source: 'env', apply: 'restart' }),
    ).toBe('未开通，上线前请让技术人员配置');
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
      // AJ-410 / N31：通道代号与属性来源挪进 techText
      '银行卡 · 接受新订单 · 排序 20 · USD；' + '模拟支付 · 只处理已有订单 · 排序 90 · JPY',
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
      NOT_SET,
    );
  });

  it('汇率缓冲按百分比显示', () => {
    expect(
      valueText({ key: 'fx_buffer_rate', value: 0.035, source: 'env', apply: 'restart' }),
    ).toBe('3.5%');
  });
});

describe('applyText', () => {
  // AJ-410 / N31：主文案不再出现变量名（挪进 techText）
  it('env：技术人员修改 + 改后需重启；变量名只在 techText；密钥类只说"部署环境变量"', () => {
    const env = { key: 'x', value: 1, source: 'env', apply: 'restart', env: 'PACKAGING_WEIGHT_G' };
    expect(applyText(env)).toBe('技术人员在服务器上修改 · 改后需重启');
    expect(techText(env)).toBe('环境变量 PACKAGING_WEIGHT_G');
    const secret = { key: 'mail_configured', value: true, source: 'env', apply: 'restart' };
    expect(techText(secret)).toBe('部署环境变量');
  });
  it('db：在后台修改 · 立即生效 / 需重启；支付通道的代号与属性来源在 techText', () => {
    expect(applyText({ key: 'x', value: null, source: 'db', apply: 'immediate' })).toBe(
      '在后台修改 · 立即生效',
    );
    expect(applyText({ key: 'x', value: null, source: 'db', apply: 'restart' })).toBe(
      '在后台修改 · 改后需重启',
    );
    expect(
      techText({
        key: 'payment_channels',
        value: [{ channel: 'stripe', attrs_source: 'table' }],
        source: 'db',
        apply: 'restart',
      }),
    ).toBe('stripe：属性来自配置表');
  });
});
