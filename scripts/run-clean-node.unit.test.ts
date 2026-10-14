/**
 * 守护脚本 `run-clean-node.mjs`：`stripRequire` 剥掉 `NODE_OPTIONS` 里的 `--require` 注入。
 *
 * @why 这是"门禁在宿主（IDE / 沙盒）里假失败"的防复发机制（约束九）：宿主往 `NODE_OPTIONS` 塞
 *      `--require=<shim>`，shim 的 fs monkey-patch 让 ESLint 类型感知用例从 5.9s 飙到 36s 超时。
 *      剥掉 `--require` 后 `test:lint` 恢复 14 文件 46 用例全绿。
 * @measured 2026-10-14：带 shim 跑 `test:lint` → exit 137；经 `run-clean-node.mjs` 包裹 → exit 0。
 */
import { describe, expect, it } from 'vitest';
import { stripRequire } from './run-clean-node.mjs';

describe('stripRequire：剥掉 NODE_OPTIONS 里的 --require 注入，其余保留', () => {
  it('undefined → undefined（没有 NODE_OPTIONS 时不产出空字符串）', () => {
    expect(stripRequire(undefined)).toBeUndefined();
  });

  it('只有 --require=value（带引号路径）→ 剥空', () => {
    expect(
      stripRequire('--require="/Applications/WorkBuddy.app/…/shim/node-language-shim.cjs"'),
    ).toBeUndefined();
  });

  it('--require=value 与合法选项并存 → 只剥 require，保留合法选项', () => {
    expect(stripRequire('--require=/path/to/shim.cjs --max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096',
    );
  });

  it('--require value（分开写）与合法选项并存 → 同样只剥 require', () => {
    expect(stripRequire('--require /path/to/shim.cjs --max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096',
    );
  });

  it('没有 require 时原样保留（不误伤合法选项）', () => {
    expect(stripRequire('--max-old-space-size=4096 --experimental-json-modules')).toBe(
      '--max-old-space-size=4096 --experimental-json-modules',
    );
  });

  it('--import 保留、--require 剥掉（只处理 require，不扩大范围）', () => {
    expect(stripRequire('--import=./x.mjs --require=c.cjs')).toBe('--import=./x.mjs');
  });

  it('开头就是 --require（无前导空白）也能剥掉', () => {
    expect(stripRequire('--require=first.cjs --require=second.cjs')).toBeUndefined();
  });
});
