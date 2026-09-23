/**
 * 职责：把「约束六·注释」从口号变成**会红的检查**（LM 层第二类）。
 *
 * @why 约束六要求注释讲清"做什么 / 为什么 / 缺点 / 取舍 / 依据"，但这条此前**完全没有强制器**：
 *      删掉一整个文件的注释，`npm run gate` 依旧全绿。而注释恰恰是本仓库最高频的失效点——
 *      复核时遇到的「注释里写着'F7 之后有库了才能做'，可这个前置早就满足了」就是典型：
 *      注释与实现各自往前走了，中间没有任何东西报错。
 *
 *      所以这里守住三条**形态**要求（有文件头、写了 why、写了缺点或取舍）。
 *      它们不是质量指标，是"至少存在"的底线——有了底线，review 才有一个可以指着说"这里不达标"的东西。
 *
 * @limitation 一：**只验"标记在不在"，不验内容对不对**。
 *              一个写了 `@limitation 无` 的文件照样能过——这条门禁拦不住敷衍的注释。
 *              质量仍然只能靠 review（对应 CLAUDE.md 的 H3 人工检查项）。
 *              把它理解成"注释已合格"是危险的误读。
 * @limitation 二：灵感型代码（一行 `export`）也在扫描范围内，同样要求文件头。
 *              这条刻意不设豁免——微小的文件往往是漂移最快的（没人觉得值得写注释）。
 * @limitation 三：`*.d.ts` 与测试文件不扫：前者通常是工具生成的，
 *              后者本身就在用名字表达意图（`it('…')`），重复要求注释会把测试写得更啰嗦。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const SOURCE_ROOTS = ['server/src', 'packages/shared/src', 'miniprogram'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((r) => walk(join(root, r)))
    .filter((f) => ['.ts', '.js'].includes(extname(f)))
    .filter((f) => !f.includes('.test.'))
    .filter((f) => !f.endsWith('.d.ts'))
    .filter((f) => !f.includes(`${sep}dist${sep}`))
    .sort();
}

interface Scanned {
  rel: string;
  source: string;
  /** 第一个语句之前的块注释（文件头），没有则为空串 */
  header: string;
}

function scan(): Scanned[] {
  return sourceFiles().map((f) => {
    const source = readFileSync(f, 'utf8');
    const m = /^\s*\/\*\*[\s\S]*?\*\//.exec(source);
    return { rel: f.slice(root.length + 1), source, header: m === null ? '' : m[0] };
  });
}

const files = scan();

describe('源码注释的存在性门禁（约束六）', () => {
  it('扫描范围非空（否则下面几条断言会集体变成假绿灯）', () => {
    // 目录改名 / 过滤条件写错导致一个文件都没扫到时，下面的断言会因为空数组而全部"通过"
    expect(files.length).toBeGreaterThan(10);
  });

  it('每个源文件都有文件头注释（删掉整个注释 gate 不会红的情况到此为止）', () => {
    const missing = files.filter((f) => f.header.length === 0).map((f) => f.rel);
    expect(missing, `这些文件没有文件头注释：\n${missing.join('\n')}`).toEqual([]);
  });

  it('文件头必须说明"为什么存在"（@why）并留依据（@see）', () => {
    const noWhy = files.filter((f) => !f.header.includes('@why')).map((f) => f.rel);
    const noSee = files.filter((f) => !f.header.includes('@see')).map((f) => f.rel);
    expect(noWhy, `缺少 @why：\n${noWhy.join('\n')}`).toEqual([]);
    expect(
      noSee,
      `缺少 @see（要能追到上游依据：ADR / D-xx / 文档章节）：\n${noSee.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * 用户明确要求：**只写优点的注释不合格**。
   * @why 缺点不写进代码，就只会存在于写它的人的脑子里。半年后（或换个人）读这段代码，
   *      看到的全是"这么设计很好"，于是放心地用在了它不该用的场景——
   *      这正是本仓库多次踩到的形态。这条断言把它从要求变成硬约束。
   */
  it('每个文件至少写了一条缺点（@limitation）或取舍（@tradeoff）', () => {
    const missing = files
      .filter((f) => !f.source.includes('@limitation') && !f.source.includes('@tradeoff'))
      .map((f) => f.rel);
    expect(missing, `只写了优点、没写缺点或取舍：\n${missing.join('\n')}`).toEqual([]);
  });

  /**
   * 顺手把"注释里写了禁用 MOTIVATION 词"也扫一遍。
   * @why `@todo` 没有编号 / 没有 owner / 没有期限，就等于永久占位——
   *      复核时在不少地方见过裸 TODO。这里不禁止 TODO，但要求它带上出处，
   *      让人能从 `JP-xx / D-xx / Rxx` 追到看板上的那一行。
   * @limitation 只扫 `@todo`，不扫行内 `TODO:`：后者在小程序 WXML 侧的写法差异较大，
   *              强行统一会引入噪音，收益不抵成本。
   */
  it('@todo 必须带编号或 owner（裸 TODO 等于永久占位）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of f.source.split('\n')) {
        const i = line.indexOf('@todo');
        if (i === -1) continue;
        const rest = line.slice(i + '@todo'.length);
        // 允许 `@todo See期 xx（owner）` / `@todo JP-xx` / `@todo R12` 这类有出处的写法
        if (!/(JP|D|R|ADR|FX|A|T|MP|SEC|P0)[- ]?\d| owner [（(]/.test(rest)) {
          offenders.push(`${f.rel}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders, `裸 @todo（要编号或 owner）：\n${offenders.join('\n')}`).toEqual([]);
  });
});
