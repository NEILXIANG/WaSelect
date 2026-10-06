/**
 * 职责：`external-pay.js`（"这张单刚在浏览器里发起过银行卡付款"的记忆）的单测（W-02）。
 * @why 银行卡走复制链接、在浏览器里付；切回小程序时支付通知往往还没到，订单仍是"待付款"。
 *      原来"确认中"的保护只接在微信支付成功回调上，正在用的银行卡通道恰好没有。
 */
import { describe, expect, it } from 'vitest';
import { EXTERNAL_PAY_WINDOW_MS, markExternalPay, recentExternalPay } from './external-pay.js';

describe('external-pay', () => {
  it('记下之后，窗口内认作"刚在外部付过"', () => {
    const memo = markExternalPay({}, 'o-1', 1_000);
    expect(recentExternalPay(memo, 'o-1', 1_000 + 60_000)).toBe(true);
  });
  it('窗口外不再认（付款窗口已过，订单该关就关）', () => {
    const memo = markExternalPay({}, 'o-1', 1_000);
    expect(recentExternalPay(memo, 'o-1', 1_000 + EXTERNAL_PAY_WINDOW_MS)).toBe(false);
  });
  it('别的订单不受影响；脏输入一律 false', () => {
    const memo = markExternalPay({}, 'o-1', 1_000);
    expect(recentExternalPay(memo, 'o-2', 2_000)).toBe(false);
    expect(recentExternalPay(null, 'o-1', 2_000)).toBe(false);
    expect(recentExternalPay({ 'o-1': 'x' }, 'o-1', 2_000)).toBe(false);
  });
  it('不改写传入的对象（返回新对象）', () => {
    const before = {};
    const after = markExternalPay(before, 'o-1', 1_000);
    expect(before).toEqual({});
    expect(after).toEqual({ 'o-1': 1_000 });
  });
});
