/**
 * 职责：订单详情模板——部分退款放在「金额」卡里（AJ-434，用户 2026-10-10 授权代决），
 *       以及商品图加载失败时的 per-item 降级（审计 UX-004）。
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

/**
 * 审计 UX-004：商品行在 `wx:for` 里，失败标记必须**按行**（带 index 下标）。
 *
 * @why 只写 `!imgFailed`（整页一个布尔值）时第一行坏图会把这一单所有商品图一起收起，
 *      而它在 wxml 上和正确写法只差 `[index]` 六个字符——两种写法肉眼几乎一样，
 *      所以这里把"`wx:if` 里必须出现 `[index]`"钉成用例。
 */
describe('订单详情：商品图加载失败不留破图（审计 UX-004）', () => {
  it('🔴 商品图绑了 binderror，且 wx:if 是按行的失败标记（不是整页一个布尔值）', () => {
    const loopStart = wxml.indexOf('wx:for="{{view.items}}"');
    expect(loopStart).toBeGreaterThan(0);
    const loopEnd = wxml.indexOf('</view>', wxml.indexOf('class="item__meta"'));
    const loop = wxml.slice(loopStart, loopEnd);

    expect(loop).toMatch(/<image\b/);
    expect(loop).toMatch(/binderror="onItemImgError"/);
    // 按行：会和 `view.items` 的行号一起算——少写 `[index]` 就变成整页共用一个标记
    expect(loop).toMatch(/wx:if="\{\{item\.image && !imgFailed\[index\]\}\}"/);
    expect(loop).toMatch(/data-index="\{\{index\}\}"/);
  });
});
