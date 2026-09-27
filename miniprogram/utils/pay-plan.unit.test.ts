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
import { channelOptions, payGuide, payPlan } from './pay-plan.js';

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
