/**
 * 职责：首页 / 商品详情首次加载显示**骨架屏**（小程序评估 B，AJ-416 代拍板"做"）。
 *
 * @why 首屏一张"正在挑选"/"加载中…"卡片 → 内容出来时整屏跳一次版式；骨架按真实版式占位
 *      （图位 + 两行字），内容出来时只是"填色"，感知等待更短，也不会误以为页面空了。
 * @limitation 只验结构（骨架挂在"首次加载且还没有内容"的条件下、用的是全站 `.ws-skeleton`）；
 *             动画观感要在模拟器 / 真机上看。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (page: string): string =>
  readFileSync(new URL(`./pages/${page}/index.wxml`, import.meta.url), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );

describe('骨架屏', () => {
  it('🔴 首页：列表为空且在加载时出骨架（图位 + 文字行），不再是一张"正在挑选"卡片', () => {
    const wxml = read('home');
    expect(wxml).toMatch(/wx:if="\{\{loading && cards\.length === 0\}\}"[^>]*>[\s\S]*?ws-skeleton/);
    expect(wxml).not.toMatch(/kind="loading"/);
  });

  it('🔴 商品详情：还没有商品数据时出骨架（大图位 + 标题行）', () => {
    const wxml = read('detail');
    expect(wxml).toMatch(/wx:if="\{\{loading && !product\}\}"[^>]*>[\s\S]*?ws-skeleton/);
    expect(wxml).not.toContain('加载中…');
  });
});
