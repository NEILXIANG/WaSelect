/**
 * 职责：订单详情模板——查件链接复制之后给出下一步（第 24 项，2026-10-10）。
 * @why 复制成功只把按钮字变成"已复制"，买家不知道接下来去哪儿（小程序里打不开外部网页，只能去浏览器）。
 * @limitation 只验模板文字，不验渲染。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync(resolve(import.meta.dirname, 'index.wxml'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
);

describe('订单详情：查件引导', () => {
  it('🔴 引导文案取 vm 的 trackingHint；复制了查件链接后说"打开手机浏览器粘贴"', () => {
    expect(wxml).toContain('{{view.trackingHint}}');
    expect(wxml).not.toContain('>点运单号复制<');
    expect(wxml).toMatch(
      /wx:if="\{\{copied === 'url'\}\}"[^>]*>\s*已复制：打开手机浏览器，粘贴到地址栏即可查看物流/,
    );
  });
});

// 全入口点击测试 2026-10-11：已发货的单，物流卡排在商品 / 金额 / 地址之后（要往下翻一屏半）；运单号行与订单号行写法不一致，
// "查件"与"复制查件链接"拆在两行、说明夹在中间。主流（淘宝 / 京东）：物流紧跟状态
describe('订单详情：物流卡的位置与写法（全入口点击测试 2026-10-11）', () => {
  const at = (s: string): number => wxml.indexOf(s);

  it('🔴 物流卡紧跟状态卡：在售后入口、商品、金额、地址之前', () => {
    const tracking = at('wx:if="{{view.hasTracking}}"');
    expect(tracking).toBeGreaterThan(0);
    for (const later of [
      'wx:if="{{view.afterSale.show}}"',
      'wx:if="{{view.items.length > 0}}"',
      'wx:if="{{view.address}}"',
    ]) {
      expect(tracking, later).toBeLessThan(at(later));
    }
  });

  it('🔴 运单号行与订单号行同一写法：号码 + 右侧「复制」；查件链接是一个按钮', () => {
    expect(wxml).toMatch(
      /<view class="track track--act"[^>]*data-kind="no"[^>]*bindtap="onCopyTracking"[^>]*>\{\{copied === 'no' \? '已复制' : '复制'\}\}<\/view>/,
    );
    expect(wxml).toMatch(/<ws-button[^>]*data-kind="url"[^>]*bindtap="onCopyTracking"/);
  });
});

// 全入口点击测试 2026-10-11：没申请过售后时，售后卡只有"售后"二字一行 + 右对齐链接一行，半张卡是空的；改为同一行
describe('订单详情：售后入口紧凑（全入口点击测试 2026-10-11）', () => {
  it('🔴 没有进行中的申请：「售后」与「申请售后」同一行', () => {
    expect(wxml).toMatch(
      /<view class="quote-line">\s*<text class="ws-note">售后<\/text>\s*<view\s+class="track track--act"\s+wx:if="\{\{view.afterSale.canApply && !view.afterSale.current\}\}"/,
    );
  });
});
