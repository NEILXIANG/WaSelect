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
  // 三端模拟测试 2026-10-11（运营看不懂的字）：设置页显示「审核模式 off」
  it('🔴 审核模式 on / off → 开启 / 关闭', () => {
    expect(valueText({ key: 'review_mode', value: 'off', source: 'env', apply: 'restart' })).toBe(
      '关闭',
    );
    expect(valueText({ key: 'review_mode', value: 'on', source: 'env', apply: 'restart' })).toBe(
      '开启（只收模拟支付，审核用）',
    );
  });

  // AJ-410 / N31：「未配置」改为告诉运营下一步（找技术人员）
  // 两端逐页走查 2026-10-12：审核模式关着，"审核商品 / 截止日"仍说"上线前请配置"；包邮门槛本可不设也这么说——
  //   运营以为有好几件事没做
  it('🔴 没填的可选项按上下文说清：审核模式关时不需要；包邮门槛未设 = 不包邮；已有替代项时说明', () => {
    const all = (reviewMode: string, extra: Record<string, unknown> = {}) => [
      { key: 'review_mode', value: reviewMode, source: 'env' as const, apply: 'restart' as const },
      {
        key: 'support_email',
        value: 'cs@waselect.jp',
        source: 'env' as const,
        apply: 'restart' as const,
      },
      { key: 'sentry_configured', value: true, source: 'env' as const, apply: 'restart' as const },
      ...Object.entries(extra).map(([key, value]) => ({
        key,
        value,
        source: 'env' as const,
        apply: 'restart' as const,
      })),
    ];
    const v = (key: string, value: unknown, ctx = all('off')) =>
      valueText({ key, value, source: 'env', apply: 'restart' } as never, ctx);
    expect(v('review_sku_id', null)).toBe('审核模式关闭时不需要');
    expect(v('review_mode_until', null)).toBe('审核模式关闭时不需要');
    expect(v('review_sku_id', null, all('on'))).toBe(NOT_SET);
    expect(v('free_shipping_jpy', null)).toBe('未设置（不包邮）');
    expect(v('support_wechat', null)).toBe('未填写（已有客服邮箱，可不填）');
    expect(v('support_hours', null)).toBe('未填写（页面不显示客服时间）');
    expect(v('alert_email_configured', false)).toBe('未开通（已有错误上报 Sentry，可不开）');
    expect(v('seller_name', null)).toBe(NOT_SET);
  });

  it('🔴 有 value_label 时显示它（审核商品显示名称与状态，编号收进技术信息）', () => {
    const it = {
      key: 'review_sku_id',
      value: 'p-1',
      value_label: '「六花亭」· 在售 · 库存 50',
      source: 'env' as const,
      apply: 'restart' as const,
      env: 'REVIEW_SKU_ID',
    };
    expect(valueText(it)).toBe('「六花亭」· 在售 · 库存 50');
    expect(techText(it)).toBe('环境变量 REVIEW_SKU_ID = p-1');
  });

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
