/**
 * 职责：每个 `<swiper>` 的 class 在本页 wxss（或 app.wxss）里都显式声明了 `height`。
 *
 * @why 三端模拟测试 2026-10-11（开发者工具模拟器实测）：详情页主图轮播没写高度，落到 swiper 默认的 150px；
 *      里面的 image 也没写高度，落到 image 默认的 240px——图比容器高，下半截被裁掉，
 *      注释里写的"aspectFit 保证全图可见"恰好不成立。两个默认值都不报错，只有在模拟器里看图才发现。
 *      首页 banner 写了 `height: var(--ws-banner-h)` 所以没事；新加的轮播只要漏写就会再犯。
 * @limitation 只认 `class="..."` 里的类名与 `.类名 { ... height: ... }` 的写法；
 *             swiper 里面 image 的高度没查（它跟着 `height: 100%` 走，靠本页样式自己保证）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname);
const strip = (s: string): string =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

function pageDirs(): string[] {
  return ['pages', 'components'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, dir, d.name, 'index.wxml')))
      .map((d) => join(root, dir, d.name)),
  );
}

function declaresHeight(css: string, cls: string): boolean {
  const re = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(re)].some((m) => /(^|[;\s{])height\s*:/.test(m[1] ?? ''));
}

describe('swiper 必须显式给高度', () => {
  const swipers = pageDirs().flatMap((d) => {
    const wxml = strip(readFileSync(join(d, 'index.wxml'), 'utf8'));
    return [
      ...wxml.matchAll(
        /<swiper(\s(?:[^>{]|\{\{[^}]*\}\})*)?>/g, // 不能用 \b：`<swiper-item` 也会被匹配；`{{a > 0}}` 里的 > 不算标签结束
      ),
    ].map((m) => ({
      dir: d,
      classes: (/class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '').split(/\s+/).filter((c) => c !== ''),
    }));
  });

  it('扫到了 swiper（扫描器自检：一个都没有时下面那条永真）', () => {
    expect(swipers.length).toBeGreaterThanOrEqual(2);
  });

  it('🔴 每个 swiper 至少有一个类在本页 wxss 或 app.wxss 里声明了 height', () => {
    const app = strip(readFileSync(join(root, 'app.wxss'), 'utf8'));
    const bad = swipers
      .filter(({ dir, classes }) => {
        const own = existsSync(join(dir, 'index.wxss'))
          ? strip(readFileSync(join(dir, 'index.wxss'), 'utf8'))
          : '';
        return !classes.some((c) => declaresHeight(own, c) || declaresHeight(app, c));
      })
      .map(
        ({ dir, classes }) =>
          `${dir.slice(root.length + 1)}：${classes.join(' ') || '（无 class）'}`,
      );
    expect(bad, 'swiper 没写高度：会落到默认 150px，里面的图被裁').toEqual([]);
  });
});
