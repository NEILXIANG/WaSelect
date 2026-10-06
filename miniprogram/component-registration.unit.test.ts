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

  it('🔴 每个 wxml 用到的 <ws-*> 都在对应 json 的 usingComponents（或 app.json 全局）里', () => {
    const missing: string[] = [];
    for (const unit of all) {
      const wxml = readFileSync(join(root, `${unit}.wxml`), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const used = new Set([...wxml.matchAll(/<(ws-[a-z-]+)[\s/>]/g)].map((m) => m[1] ?? ''));
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
