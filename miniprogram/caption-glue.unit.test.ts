/**
 * 职责：两段提示类文字（`ws-caption` / `ws-note`）前后相邻时，至少一段必须是块级（否则在同一行里粘成一句）；
 *       `wx:for` 循环出来的提示类文字自己必须是块级（否则条与条之间粘连）。
 *
 * @why 三端模拟测试 2026-10-11（开发者工具模拟器实测）：结算页合计下面写成
 *      "≈ $2,585.88 · ≈ ¥18,823.66其中预估关税 54,000 円（已含在商品价内）已超过单笔上限，请分两单下单"——
 *      三句连成一段，最要紧的"超过单笔上限"埋在中间；订单详情的折算与关税说明同病。
 *      `<text>` 是行内元素，相邻两段只要都不是块级就会接在一起；购物车 10-09 修过一次（`line-block`），
 *      当时只修了那一处，于是在另外三页再犯。
 * @limitation 只看 class 是否在 wxss 里声明了 `display: block`；父容器是纵向 flex 时其实不会粘，这里仍会要求加类
 *             （多加一个 line-block 无害）。`wx:elif` / `wx:else` 的下一段与上一段不会同时出现，不算相邻。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname);
const stripXml = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCss = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

function blockClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripCss(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/display\s*:\s*block/.test(m[2] ?? '')) continue;
    for (const c of (m[1] ?? '').matchAll(/\.([A-Za-z0-9_-]+)\s*(?:,|$)/g)) out.add(c[1] ?? '');
  }
  return out;
}

/**
 * 豁免（必须写原因）：
 * - `item__qty`：订单详情行项目里"单价 …… × 2"，父容器是横排 flex，本来就该同一行（数量靠右）。
 */
const INLINE_OK = new Set(['item__qty']);

const classesOf = (attrs: string): string[] =>
  (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter((c) => c !== '');
const isCaption = (cls: string[]): boolean => cls.includes('ws-caption') || cls.includes('ws-note');

function pages(): string[] {
  return ['pages', 'components'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, dir, d.name, 'index.wxml')))
      .map((d) => join(root, dir, d.name)),
  );
}

describe('提示类文字不粘连', () => {
  const app = blockClasses(readFileSync(join(root, 'app.wxss'), 'utf8'));

  function violations(): string[] {
    const bad: string[] = [];
    for (const dir of pages()) {
      const wxml = stripXml(readFileSync(join(dir, 'index.wxml'), 'utf8'));
      const own = existsSync(join(dir, 'index.wxss'))
        ? blockClasses(readFileSync(join(dir, 'index.wxss'), 'utf8'))
        : new Set<string>();
      const isBlock = (cls: string[]): boolean => cls.some((c) => app.has(c) || own.has(c));
      const where = (i: number): string =>
        `${dir.slice(root.length + 1)}:${String(wxml.slice(0, i).split('\n').length)}`;
      for (const m of wxml.matchAll(/<text\b([^>]*)>[^<]*<\/text>\s*<text\b([^>]*)>/g)) {
        const a = classesOf(m[1] ?? '');
        const b = classesOf(m[2] ?? '');
        if (/wx:(elif|else)\b/.test(m[2] ?? '')) continue;
        if ([...a, ...b].some((c) => INLINE_OK.has(c))) continue;
        if (isCaption(a) && isCaption(b) && !isBlock(a) && !isBlock(b))
          bad.push(`${where(m.index)} 相邻`);
      }
      for (const m of wxml.matchAll(/<text\b([^>]*\bwx:for=[^>]*)>/g)) {
        const c = classesOf(m[1] ?? '');
        if (isCaption(c) && !isBlock(c)) bad.push(`${where(m.index)} wx:for`);
      }
    }
    return bad;
  }

  it('扫描器自检：认得出 app.wxss 里的块级类（一个都没有时下面那条永真）', () => {
    expect(app.size).toBeGreaterThan(0);
  });

  it('🔴 相邻的两段提示类文字至少一段是块级；wx:for 的提示类文字是块级', () => {
    expect(violations(), '会在同一行里粘成一句：给其中一段加 line-block').toEqual([]);
  });
});
