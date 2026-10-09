/**
 * 职责：正方形图位（`.ws-media--square`）不得和"限宽"的类挂在同一个节点上。
 *
 * @why 2026-10-08 三端联动走查（开发者工具模拟器）实测：正方形靠 `padding-bottom: 100%` 撑高，
 *      而百分比内边距按**父容器**宽度算——购物车把图位本身限成 30% 宽时，高度却是整行宽度，
 *      图变成一根竖条、每行撑到大半屏（订单列表 18%、订单详情 20% 同病）。
 *      正确写法是外层节点管宽度、里层只挂 `ws-media ws-media--square`。
 * @limitation 只认 class 属性的写法；把宽度写进行内 style 也会同样出事，但项目禁止行内尺寸（design-token 门禁）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname);

function wxmlFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['pages', 'components']) {
    for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
      const f = join(root, dir, d.name, 'index.wxml');
      if (d.isDirectory() && existsSync(f)) out.push(f);
    }
  }
  return out;
}

describe('正方形图位（ws-media--square）', () => {
  it('扫到了用正方形图位的模板（扫描器自检：一个都没有时下面那条是永真的）', () => {
    const used = wxmlFiles().filter((f) => readFileSync(f, 'utf8').includes('ws-media--square'));
    expect(used.length).toBeGreaterThanOrEqual(3);
  });

  it('🔴 挂 ws-media--square 的节点只带 ws-media 基础类（宽度交给外层节点）', () => {
    const bad: string[] = [];
    for (const f of wxmlFiles()) {
      const src = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      for (const m of src.matchAll(/class="([^"]*\bws-media--square\b[^"]*)"/g)) {
        const extra = (m[1] ?? '')
          .split(/\s+/)
          .filter((c) => c !== '' && c !== 'ws-media' && c !== 'ws-media--square');
        if (extra.length > 0) bad.push(`${f.slice(root.length + 1)}：${extra.join(' ')}`);
      }
    }
    expect(bad, '正方形图位上挂了别的类（可能限宽 → 竖条）').toEqual([]);
  });
});

describe('图位是定位容器（三端联动走查 2026-10-08）', () => {
  /**
   * 🔴 `.ws-media` 基础类自带 `position: relative`。
   * @why 首页卡片的"仅剩 N 件 / 已售罄"角标是 absolute 定位、挂在图位里；`ws-media--scene` 原先没有
   *      定位上下文，角标一路逃到页面左上角，压在"日本選品"字标上（几张卡的角标还叠在同一处）——
   *      模拟器里换上真实库存数据后才看见。只给某一档补会漏下一档，所以补在基础类上。
   */
  it('🔴 app.wxss 的 .ws-media 声明了 position: relative', () => {
    const css = readFileSync(join(root, 'app.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /\.ws-media\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/position:\s*relative/);
  });
});
