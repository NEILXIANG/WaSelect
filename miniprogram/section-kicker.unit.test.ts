/**
 * 职责：页面里的区块小标题（`ws-section-kicker`）要么是中文，要么后面紧跟一个中文标题（成对的品牌装饰写法）。
 *
 * @why 三端模拟测试 2026-10-11（报告 §7-1，用户授权代决 AJ-489）：结算 / 订单详情 / 商品详情 / 支付页的卡片小标题是
 *      ITEMS / AMOUNT / SHIPPING TO / DESCRIPTION / GUARANTEE……旁边没有中文，买家（在美华人，中文为主）要靠猜。
 *      成对的写法（如 BEFORE YOU PAY 下面紧跟「支付前请确认」）保留——英文只是装饰，信息由中文标题给出。
 * @limitation 只看模板里写死的文字与 `{{ }}` 里的字符串字面量；由 data 传进来的小标题（ws-section-head 的 kicker 属性）
 *             不在本检查内——那个组件总是和 title 一起出现。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname);
const CJK = /[一-鿿]/;

function pages(): string[] {
  return readdirSync(join(root, 'pages'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, 'pages', d.name, 'index.wxml')))
    .map((d) => join(root, 'pages', d.name, 'index.wxml'));
}

describe('区块小标题是中文（或与中文标题成对）', () => {
  const found: Array<{ file: string; text: string; paired: boolean }> = [];
  for (const f of pages()) {
    const src = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.matchAll(
      /<text\b[^>]*\bws-section-kicker\b[^>]*>([^<]*)<\/text>\s*(<text\b[^>]*>([^<]*)<\/text>)?/g,
    )) {
      const inner = m[1] ?? '';
      const literals = inner.includes('{{')
        ? [...inner.matchAll(/'([^']*)'/g)].map((x) => x[1] ?? '')
        : [inner];
      for (const t of literals) {
        found.push({
          file: f.slice(root.length + 1),
          text: t.trim(),
          paired: /ws-title/.test(m[2] ?? '') && CJK.test(m[3] ?? ''),
        });
      }
    }
  }

  it('扫描器自检：扫到了小标题（一个都没有时下面那条永真）', () => {
    expect(found.length).toBeGreaterThan(5);
  });

  it('🔴 没有中文标题陪着的小标题必须是中文', () => {
    const bad = found
      .filter((k) => !k.paired && !CJK.test(k.text))
      .map((k) => `${k.file}：${k.text}`);
    expect(bad, '买家看不懂的英文小标题：改成中文，或在后面紧跟一个中文 ws-title').toEqual([]);
  });
});
