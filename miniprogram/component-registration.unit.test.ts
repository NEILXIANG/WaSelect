/**
 * 职责：模板里用到的自定义组件（`<ws-*>`）必须在该页 / 该组件的 json 里登记（或在 app.json 全局登记）。
 *
 * @why 剩余清单 4-8 实测踩到：支付页 wxml 加了 `<ws-state-block>`，所有单测全绿，但 `pages/pay/index.json`
 *      没登记它——真机上这个标签**静默不渲染**（不报错），"无可用支付方式"的空态根本不会出现。
 *      页面单测只验薄壳的 data，验不到"标签能不能被宿主认出"，所以这一类只能靠扫描兜住（约束九：防复发优先）。
 * @limitation 只认 `ws-` 前缀的自定义组件（本项目组件统一前缀）；原生组件不在检查内。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname);
const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as {
  usingComponents?: Record<string, string>;
};
const globalTags = new Set(Object.keys(appJson.usingComponents ?? {}));

/**
 * 模板里用到的 `<ws-*>` 标签（先剥注释）。
 * @why 自检与正式扫描共用这一个函数：自检若各抄一份正则，验到的是副本而不是门禁本身——
 *      2026-10-08 实测踩到：副本漏了剥注释，自检自己红了，而正式扫描是对的。
 */
function usedTags(wxml: string): string[] {
  return [...wxml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(ws-[a-z-]+)[\s/>]/g)].map(
    (m) => m[1] ?? '',
  );
}

function units(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, dir, d.name, 'index.wxml')))
    .map((d) => join(dir, d.name, 'index'));
}

describe('自定义组件登记（剩余清单 4-8 起）', () => {
  const all = [...units('pages'), ...units('components')];

  it('扫到了页面与组件（扫描器自检：一个都扫不到时下面那条是永真的）', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  /**
   * 匹配器自检：`<ws-*>` 标签正则必须真的能命中，否则 `used` 集合恒空 → `missing` 恒空 → 门禁假绿。
   * @why 只自检"扫描到了文件"不够——扫描对了但正则写坏（前缀改错、边界字符改错），
   *      门禁照样永远绿，而它声称要拦的"用组件没登记 → 真机静默不渲染"照样发生。
   *      注入两段样本：一段应命中、一段应被正确放过，证明正则抓得准。
   */
  it('匹配器自检：能抓到 <ws-x> 标签、也能放过非组件标签与注释', () => {
    const capture = usedTags;
    // 应命中：带空格、带属性、自闭合三种写法
    expect(capture('<ws-state-block />\n<ws-price amount="100"/>\n<ws-button>')).toEqual([
      'ws-state-block',
      'ws-price',
      'ws-button',
    ]);
    // 应放过：非 ws- 前缀、原生标签、注释里的反例
    // 不再 filter('')（2026-10-09 审计）：正则若写坏到抓出空串，原写法会把它滤掉、自检照绿
    expect(capture('<view>\n<text>\n<!-- <ws-ghost> 注释不算 -->\n<ws>')).toEqual([]);
  });

  it('🔴 每个 wxml 用到的 <ws-*> 都在对应 json 的 usingComponents（或 app.json 全局）里', () => {
    const missing: string[] = [];
    for (const unit of all) {
      const used = new Set(usedTags(readFileSync(join(root, `${unit}.wxml`), 'utf8')));
      const jsonPath = join(root, `${unit}.json`);
      const json = existsSync(jsonPath)
        ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as {
            usingComponents?: Record<string, string>;
          })
        : {};
      const local = new Set(Object.keys(json.usingComponents ?? {}));
      for (const tag of used) {
        if (!local.has(tag) && !globalTags.has(tag))
          missing.push(`${unit}.wxml 用了 <${tag}> 却没登记`);
      }
    }
    expect(missing).toEqual([]);
  });
});
