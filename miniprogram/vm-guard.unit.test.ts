/**
 * 职责：约束十一的守卫——**抽了 vm 就必须有单测**，且 vm 必须真的是纯函数。
 *
 * @why 页面逻辑抽成 `*.vm.js` 这件事本身**没有价值**，有价值的是它因此可被单测。
 *      而"抽了 vm 却没写测试"是完全可能发生的：文件建好了、函数也导出了，
 *      看起来比写在 `index.js` 里"规范"得多，实际上逻辑换了个地方继续裸奔——
 *      并且**不会有任何一条测试变红**（没有测试可红）。所以这条只能机器守。
 *
 * @why 同时拦"vm 里出现 `wx.` / `new Date(`"：那两样正是让它**失去可测性**的元凶——
 *      读了 `wx` 就要造全局桩，用了 `new Date()` 测试结果就随时间变。
 *      允许它们存在，等于允许 vm 退化回不可测的页面逻辑。
 *
 * @limitation 一：是**形态级**正则（剥注释后匹配 `wx.` / `new Date(`），不是 AST。
 *              写成 `const w = wx; w.request(...)` 扫不到。
 *              @why 本规则的真实威胁是"顺手用一下"，形态级足够；真出现刻意绕过再升级到解析。
 * @limitation 二：**不强制**"每个页面都必须有 vm"——纯静态页（法务页）没有逻辑可抽，
 *              硬抽只会产出一个空壳函数，反而制造"我测过了"的假象。
 *              本守卫只管"有 vm 就要有测试"，不管"有没有 vm"。
 * @limitation 三：只扫 `miniprogram/pages/` 下的 `.vm.js`；将来 vm 若放到别处（如共享的
 *              `utils/`）需要同步改这里的扫描根。
 *
 * @see CLAUDE.md 约束十一；docs/自主决策记录.md AJ-123
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES_DIR = join(resolve(import.meta.dirname, '..'), 'miniprogram', 'pages');

/** 递归收所有 vm 文件。@see @limitation 三 */
function collectVmFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectVmFiles(full, out);
    else if (entry.name.endsWith('.vm.js')) out.push(full);
  }
  return out;
}

/** 剥掉块注释与行注释，避免"注释里解释这条规则"被当成违规。@see @limitation 一 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const vmFiles = collectVmFiles(PAGES_DIR);
const show = (p: string): string => p.slice(p.indexOf('miniprogram/'));

describe('约束十一：页面 vm（*.vm.js）', () => {
  it('扫描到了 vm 文件（防目录改名 / 扫描器失效让下面几条永远绿）', () => {
    expect(vmFiles.length, `应在 ${PAGES_DIR} 下找到至少一个 vm 文件`).toBeGreaterThan(0);
  });

  it('每个 vm 都有同名单测（抽了 vm 却不测 = 逻辑换个地方裸奔）', () => {
    for (const vm of vmFiles) {
      const testFile = vm.replace(/\.vm\.js$/, '.vm.unit.test.ts');
      expect(existsSync(testFile), `${show(vm)} 缺少配套单测 ${show(testFile)}`).toBe(true);
    }
  });

  it('vm 里不得出现 wx. 或 new Date(（出现即不再是纯函数，也就不可测）', () => {
    for (const vm of vmFiles) {
      const src = stripComments(readFileSync(vm, 'utf8'));
      expect(src, `${show(vm)} 不应读 wx 全局`).not.toMatch(/\bwx\./);
      expect(src, `${show(vm)} 不应 new Date()（时间由入参给，与 F10 同口径）`).not.toMatch(
        /new\s+Date\s*\(/,
      );
    }
  });
});
