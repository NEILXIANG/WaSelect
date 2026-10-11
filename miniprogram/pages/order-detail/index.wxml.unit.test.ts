/**
 * 职责：订单详情模板——部分退款放在「金额」卡里（AJ-434，用户 2026-10-10 授权代决）。
 *
 * @why 原先部分退款是页面最底部单独一张卡，离"订单合计"隔着地址、物流、进度、条款四张卡；
 *      买家想核对"付了多少、退了多少"得上下翻，三端走查时就没看到它。
 * @limitation 只验模板结构，不验渲染；效果以模拟器截图为准（AJ-434 下游）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync(resolve(import.meta.dirname, 'index.wxml'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
);

describe('订单详情：部分退款的位置（AJ-434）', () => {
  it('🔴 部分退款在「金额」卡里（订单合计之后、收货地址之前），页面上只出现一次', () => {
    const amount = wxml.indexOf('>金额<');
    const shipping = wxml.indexOf('>收货地址<');
    const refunds = wxml.indexOf('view.partialRefunds');
    expect(amount).toBeGreaterThan(0);
    expect(refunds).toBeGreaterThan(wxml.indexOf('view.totalSub', amount));
    expect(refunds).toBeLessThan(shipping);
    expect(wxml.match(/wx:for="\{\{view\.partialRefunds\}\}"/g)).toHaveLength(1);
  });
});
