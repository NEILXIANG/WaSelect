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
