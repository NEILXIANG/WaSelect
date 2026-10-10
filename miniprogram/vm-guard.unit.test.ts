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

/**
 * 正式扫描与自检**共用**的三条匹配器（2026-10-09 审计 WorkBuddy 补丁时收拢）。
 * @why 自检若各抄一份正则，验到的是副本而不是门禁本身——正式那份写坏了，副本自检照样绿
 *      （component-registration 的副本自检就因漏剥注释自己红过）。
 */
const WX_GLOBAL = /\bwx\./;
const NEW_DATE = /new\s+Date\s*\(/;
/** "空断言"：expect 的实参是字面量（true / false / 数字 / 字符串）——断言的是常量，什么都没测。 */
const TRIVIAL_EXPECT = /expect\s*\(\s*(?:true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`)\s*\)/g;

/** "自证"：同一个变量 / 属性链和它自己比（`expect(v).toBe(v)`），永远成立（统一结论操作律 6）。 */
const SELF_EXPECT =
  /expect\s*\(\s*([\w$.]+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g;

/** 剥掉注释、"空断言"与"自证"之后，还有没有真正的 expect(...) 调用。 */
function hasRealAssertion(testSrc: string): boolean {
  return /expect\s*\(/.test(testSrc.replace(TRIVIAL_EXPECT, '').replace(SELF_EXPECT, ''));
}

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

  /**
   * 🔴 配套单测**必须有真断言**，不能是空壳（只 describe 不 it、或只有 `expect(true).toBe(true)`）。
   * @why `existsSync` 只证明"文件在"；空壳文件同样通过"文件存在"检查，却什么都没测——逻辑照样裸奔，而门禁是绿的。
   * @why 只找 `expect(` 字样挡不住 `expect(true).toBe(true)`（WorkBuddy 原补丁的写法，审计时发现）——
   *      先剥掉实参是字面量的"空断言"再找。
   * @limitation 形态级：`expect(v).toBe(v)` 这类同名自证已能识别（SELF_EXPECT）；换个别名（`const w = v; expect(v).toBe(w)`）仍能绕过——那是刻意对抗，真要防再升级 AST。
   */
  it('🔴 每个 vm 的配套单测文件里真的有断言（不是空壳）', () => {
    for (const vm of vmFiles) {
      const testFile = vm.replace(/\.vm\.js$/, '.vm.unit.test.ts');
      if (!existsSync(testFile)) continue; // 文件缺失由上面那条报，这里不重复
      const testSrc = stripComments(readFileSync(testFile, 'utf8'));
      expect(
        hasRealAssertion(testSrc),
        `${show(testFile)} 存在但没有任何真断言（只有空壳或 expect(字面量)）`,
      ).toBe(true);
    }
  });

  it('vm 里不得出现 wx. 或 new Date(（出现即不再是纯函数，也就不可测）', () => {
    for (const vm of vmFiles) {
      const src = stripComments(readFileSync(vm, 'utf8'));
      expect(src, `${show(vm)} 不应读 wx 全局`).not.toMatch(WX_GLOBAL);
      expect(src, `${show(vm)} 不应 new Date()（时间由入参给，与 F10 同口径）`).not.toMatch(
        NEW_DATE,
      );
    }
  });

  /**
   * 匹配器自检：`wx.` / `new Date(` 两条正则必须真的能命中，否则"纯函数"约束形同虚设。
   * @why 正则写坏（比如 `wx.` 的点没转义、`new\s+Date` 的空白符写错）→ 违规 vm 永远扫不出来，
   *      门禁假绿。注入反例样本证明两条正则各能抓到自己那一类。
   */
  it('匹配器自检：wx. / new Date( / 空断言三条匹配器各能命中各自的违规（与正式扫描同一份）', () => {
    expect(stripComments('wx.request({})')).toMatch(WX_GLOBAL);
    expect(stripComments('const d = new Date();')).toMatch(NEW_DATE);
    // 注释里的反例必须被 stripComments 剥掉、不算违规（否则会把自己扫成违规）
    expect(stripComments('// wx.request 是说明\nconst a = 1;')).not.toMatch(WX_GLOBAL);
    expect(stripComments('/* new Date() 不可用 */\nconst a = 1;')).not.toMatch(NEW_DATE);
    // 空壳判定：只有字面量断言 = 没有真断言；有一条断言真实值 = 有
    expect(
      hasRealAssertion("it('x', () => { expect(true).toBe(true); expect(1).toBe(1); });"),
    ).toBe(false);
    expect(hasRealAssertion("describe('x', () => {});")).toBe(false);
    // 统一结论操作律 6：拿一个值和它自己比，永远成立——同样是空断言
    expect(hasRealAssertion("it('x', () => { const v = rows(); expect(v).toBe(v); });")).toBe(
      false,
    );
    expect(
      hasRealAssertion(
        "it('x', () => { expect(a.b).toEqual(a.b); expect(c).toStrictEqual( c ); });",
      ),
    ).toBe(false);
    expect(hasRealAssertion("it('x', () => { const v = rows(); expect(v).toBe(w); });")).toBe(true);
    expect(hasRealAssertion("it('x', () => { expect(cartRows([])).toEqual([]); });")).toBe(true);
  });
});
