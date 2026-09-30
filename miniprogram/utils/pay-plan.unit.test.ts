/**
 * 职责：`utils/pay-plan.js` 的单测。
 *
 * @why 钉的全是"点了之后看起来成功、实际是坏的"：
 *      ① 按通道名分支 → 新增支付方式必须发版（ADR-28 明令禁止）；
 *      ② 微信五参数缺一个仍去调 `wx.requestPayment` → 宿主报黑盒错，指向错地方；
 *      ③ redirect 通道被显示出来 → 点了没反应（本项目认定的最坏形态）；
 *      ④ 前端重排通道顺序 → 后台改优先级、小程序不变。
 */
import { describe, expect, it } from 'vitest';
import {
  CHARGE_CURRENCY_ORDER,
  channelOptions,
  chargeOptions,
  payGuide,
  payNotice,
  payPlan,
} from './pay-plan.js';

/** 完整的微信支付五参数（契约 PaymentIntent.payload 的 wechat 形状）。 */
const WX_PAY = {
  timeStamp: '1712345678',
  nonceStr: 'n-abcdef1234',
  package: 'prepay_id=wx1234567890',
  signType: 'RSA',
  paySign: 'sign-xxxx',
};

describe('channelOptions（支付入口）', () => {
  it('只留 in_app / copylink；label 缺失回落 channel', () => {
    const out = channelOptions({
      items: [
        { channel: 'wechat', entryMode: 'in_app', label: '微信支付' },
        { channel: 'stripe', entryMode: 'copylink', label: '银行卡（Stripe）' },
        { channel: 'other', entryMode: 'redirect', label: '跳转支付' },
        { channel: 'nolabel', entryMode: 'in_app' },
      ],
    });
    expect(out).toEqual([
      { channel: 'wechat', label: '微信支付' },
      { channel: 'stripe', label: '银行卡（Stripe）' },
      { channel: 'nolabel', label: 'nolabel' },
    ]);
  });

  it('⚠️ **保持服务端顺序**（priority 由后台定，前端重排 = 两处各定一次顺序）', () => {
    const out = channelOptions({
      items: [
        { channel: 'b', entryMode: 'copylink', label: 'B' },
        { channel: 'a', entryMode: 'in_app', label: 'A' },
      ],
    });
    expect(out.map((c: { channel: string }) => c.channel)).toEqual(['b', 'a']);
  });

  it('脏输入：null / 无 items / 缺 channel → 空数组', () => {
    expect(channelOptions(null)).toEqual([]);
    expect(channelOptions({})).toEqual([]);
    expect(channelOptions({ items: [{ entryMode: 'in_app' }] })).toEqual([]);
  });
});

describe('payPlan（下一步做什么，**不认通道名**）', () => {
  it('微信五参数齐 → in_app，且参数原样透传', () => {
    expect(payPlan({ channel: 'wechat', payload: WX_PAY })).toEqual({
      kind: 'in_app',
      params: WX_PAY,
    });
  });

  it('⚠️ 五参数缺一个 → **不是** in_app（少传会让 wx.requestPayment 报黑盒错）', () => {
    const { paySign, ...rest } = WX_PAY;
    expect(paySign).toBeTruthy();
    expect(payPlan({ channel: 'wechat', payload: rest }).kind).not.toBe('in_app');
  });

  it('⚠️ 通道名换成别的也照样认（新增支付方式不改契约、不发版）', () => {
    // @why 这条钉的是 @limitation 一 的反面：若有人改成按 channel 名分支，
    //      'wechat-alipay' 这种名字会走到 unsupported，而 payload 明明是齐的。
    expect(payPlan({ channel: 'brand-new-channel', payload: WX_PAY }).kind).toBe('in_app');
  });

  it('payload.pay_url → copylink（D-49 短链，小程序不接收 client_secret）', () => {
    expect(payPlan({ channel: 'stripe', payload: { pay_url: 'https://pay.test/l/abc' } })).toEqual({
      kind: 'copylink',
      url: 'https://pay.test/l/abc',
    });
  });

  it('⚠️ auto=true 判在最前（审核期 mock：不许去调不存在的支付控件）', () => {
    expect(payPlan({ channel: 'mock', payload: { auto: true, orderId: 'o-1' } })).toEqual({
      kind: 'auto',
    });
  });

  it('auto=false（非审核模式的 mock：服务端不会自动确认）→ unsupported，**绝不**显示"支付已完成"（AJ-179）', () => {
    expect(payPlan({ channel: 'mock', payload: { auto: false, orderId: 'o-1' } }).kind).toBe(
      'unsupported',
    );
  });

  it('空 payload / 脏输入 → unsupported（带原因，不是静默成功）', () => {
    expect(payPlan({}).kind).toBe('unsupported');
    expect(payPlan(null).kind).toBe('unsupported');
    // 判别联合：先收窄到 unsupported 再读 reason（直接读会拿到其它分支的联合）
    const p = payPlan({ payload: {} });
    expect(p.kind === 'unsupported' ? p.reason : '').toContain('不可用');
  });
});

describe('payGuide（引导文案）', () => {
  it('copylink → 引导去浏览器 + "复制链接"', () => {
    const g = payGuide({ kind: 'copylink', url: 'https://pay.test/l/abc' });
    expect(g.title).toBe('请在浏览器中完成支付');
    expect(g.actionText).toBe('复制链接');
    expect(g.body).toContain('Stripe');
  });

  it('auto → 已完成 + "查看订单"', () => {
    expect(payGuide({ kind: 'auto' }).actionText).toBe('查看订单');
  });

  it('unsupported → 明示不可用并带上 reason', () => {
    const g = payGuide({ kind: 'unsupported', reason: '支付参数不完整' });
    expect(g.body).toContain('支付参数不完整');
    expect(g.actionText).toBe('返回订单');
  });

  it('⚠️ in_app 不需要引导屏 → 全空（wxml 按 title 空与否决定是否渲染那一屏）', () => {
    expect(payGuide({ kind: 'in_app' })).toEqual({ title: '', body: '', actionText: '' });
  });
});

/**
 * §14.2 支付前明确提示（官方《小程序平台运营规范》§14.2，D-48；AJ-180）。
 * @why 两个会"看起来能用、实际是坏的"的形态被钉在这里：
 *      ① 通道只按 JPY 查 → 只声明 USD 的银行卡通道**永远不出现**（服务端 P1 修复后通道按对外币种列出）；
 *      ② 提示里的金额与实扣不一致 → 用户看到的不是被扣的（§14.2 要的正是"扣多少说清楚"）。
 */
describe('chargeOptions（多币种列出 → 带实扣币种与金额的选项，§14.2）', () => {
  const ORDER = {
    total_jpy: 12_000,
    display: { USD: 8_040, CNY: 58_800 },
    created_at: '2026-09-29T01:00:00.000Z',
    expires_at: '2026-09-29T01:30:00.000Z',
  };
  const listing = (currency: string, items: unknown[]) => ({ currency, resp: { items } });

  it('查询顺序与服务端扣款币种规则同口径：JPY 锚优先，其次 USD', () => {
    expect(CHARGE_CURRENCY_ORDER).toEqual(['JPY', 'USD']);
  });

  it('只在 USD 下列出的银行卡通道也要出现，实扣 = 订单 display.USD（与服务端 resolveCharge 同一换算）', () => {
    const out = chargeOptions(
      [
        listing('JPY', [{ channel: 'wechat', entryMode: 'in_app', label: '微信支付' }]),
        listing('USD', [{ channel: 'stripe', entryMode: 'copylink', label: '银行卡' }]),
      ],
      ORDER,
    );
    expect(out).toEqual([
      {
        channel: 'wechat',
        label: '微信支付',
        entryMode: 'in_app',
        charge: { currency: 'JPY', amount: 12_000, text: '12,000 円' },
        buttonText: '微信支付（12,000 円）',
      },
      {
        channel: 'stripe',
        label: '银行卡',
        entryMode: 'copylink',
        charge: { currency: 'USD', amount: 8_040, text: '$80.40' },
        buttonText: '银行卡（$80.40）',
      },
    ]);
  });

  it('同一通道在两个币种下都列出 → 取 JPY（先到先得，不重复出现）', () => {
    const both = { channel: 'x', entryMode: 'in_app', label: 'X' };
    const out = chargeOptions([listing('JPY', [both]), listing('USD', [both])], ORDER);
    expect(out.map((o) => [o.channel, o.charge.currency])).toEqual([['x', 'JPY']]);
  });

  it('订单没有 USD 展示价 → 金额未知，文案不编数字（amount=null）', () => {
    const out = chargeOptions(
      [listing('USD', [{ channel: 'stripe', entryMode: 'copylink', label: '银行卡' }])],
      { ...ORDER, display: {} },
    );
    expect(out[0]?.charge).toEqual({
      currency: 'USD',
      amount: null,
      text: '美元（金额以支付页为准）',
    });
    expect(out[0]?.buttonText).toBe('银行卡');
  });

  it('redirect / 脏数据照旧过滤；listings 非数组 → []', () => {
    expect(
      chargeOptions([listing('JPY', [{ channel: 'r', entryMode: 'redirect' }, null])], ORDER),
    ).toEqual([]);
    expect(chargeOptions(null, ORDER)).toEqual([]);
  });
});

describe('payNotice（§14.2 提示条文案）', () => {
  const ORDER = {
    total_jpy: 12_000,
    display: { USD: 8_040 },
    created_at: '2026-09-29T01:00:00.000Z',
    expires_at: '2026-09-29T01:30:00.000Z',
  };

  it('三要素齐全：每个通道的实扣币种与金额 / copylink 在浏览器完成 / 超时关单分钟数（来自订单自己的两个时刻）', () => {
    const opts = chargeOptions(
      [
        {
          currency: 'JPY',
          resp: { items: [{ channel: 'wechat', entryMode: 'in_app', label: '微信支付' }] },
        },
        {
          currency: 'USD',
          resp: { items: [{ channel: 'stripe', entryMode: 'copylink', label: '银行卡' }] },
        },
      ],
      ORDER,
    );
    expect(payNotice(opts, ORDER)).toEqual([
      '微信支付：将以日元扣款 12,000 円',
      '银行卡：将以美元扣款 $80.40',
      '选择「银行卡」需复制支付链接，在手机浏览器中打开完成支付',
      '订单 30 分钟内未支付将自动关闭',
    ]);
  });

  it('时刻缺失 / 不可解析 → 不编分钟数，给不带数字的关单提示', () => {
    expect(payNotice([], { ...ORDER, created_at: 'bad' })).toEqual(['订单超时未支付将自动关闭']);
  });
});
