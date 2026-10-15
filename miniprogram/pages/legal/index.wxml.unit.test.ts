/**
 * 职责：条款页模板的版式（全入口点击测试 2026-10-11）。
 * @why 实测：每张文档卡标题后紧跟"复制链接后在浏览器中打开查看全文"，读成"用户协议复制链接后…"一句话；
 *      4 类文档 × 3 语种每行都挂完整网址，整页三屏长；卡与卡之间没有间距。
 *      改为：说明只在页顶说一次；卡里只有标题 + 三个语种的「复制链接」；网址只在复制失败时出现（兜底手动长按复制）。
 * @limitation 只验模板结构，不验渲染。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wxml = readFileSync(new URL('./index.wxml', import.meta.url), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
);

describe('条款页版式', () => {
  it('🔴 "复制链接后在浏览器中打开"只在页顶说一次，不再挂在每张卡标题后面', () => {
    expect(wxml.match(/浏览器/g) ?? []).toHaveLength(1);
    expect(wxml).toMatch(/<text class="ws-note legal__hint"/);
  });

  it('🔴 网址只在复制失败时出现（兜底手动复制）', () => {
    const urls = wxml.match(/<text class="doc-url"[^>]*>/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toContain('wx:if="{{copyError}}"');
  });

  it('🔴 文档卡之间有间距（每张卡外层带 legal__doc）', () => {
    expect(wxml).toMatch(/<view class="ws-gutter legal__doc" wx:for="\{\{docs\}\}"/);
  });

  /**
   * 审计 CPY-13：`documents` 没给时退回只有用户协议三语链接的那张卡，原先**只有语种行**，
   * 没有标题 —— 它和上面那几张卡长得不一样，看不出自己是哪份文件。
   */
  it('🔴 回退分支（docs 为空）也有文档标题：用户协议', () => {
    const fallback = wxml.slice(wxml.indexOf('docs.length === 0'));
    expect(fallback).toContain('<text class="doc-label">用户协议</text>');
  });
});
