/**
 * 职责：测试文件归属守卫——每个测试文件都必须落在 vitest 五层 project 之一的 include 里。
 * @why vitest 只跑 projects include 命中的文件：文件名后缀写错（比如裸 `.test.ts`、
 *      自创 `.integration.test.ts`）的测试**不属于任何层、静默不跑**，而 gate 照样全绿——
 *      "写了测试"与"测试在跑"长得一模一样，是最危险的一类假绿灯。
 *      本守卫扫全仓测试文件，逐一断言被至少一层 include 命中；孤儿文件名列在报错里。
 * @tradeoff 匹配器是 include 模式的**最小子集实现**（只认 `**\/<body>` 与 `<prefix>/**\/<body>` 两种形态），
 *      不引 glob 库——micromatch 只是传递依赖，挂上去 hoisting 一变就静默失效（AJ-75 同教训）。
 *      代价：include 出现新形态时本测试会红，提醒同步扩展匹配器——这是刻意的"改形态必被发现"。
 * @limitation 只守"归属"不守"内容放对层"（db 用例写进 .unit 文件它管不了，那靠评审）。
 * @see vitest.config.mts（五层 include 的唯一真源，本测试从配置对象直接读，不是第二份名单）
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type Project = { name: string; include: string[] };

const ROOT = join(__dirname, '../..');

/**
 * 从 vitest.config.mts **文本**提取五层 include（与 gate-scripts 测试读 package.json 同模式）。
 * @why 不用 import 配置文件：.mts 被 import 会把它拉进 tsc 编译图，
 *      而根 tsconfig 未开 allowImportingTsExtensions（NodeNext 运行时不认 .ts 后缀 import，
 *      开了等于放宽全仓规则换一处方便，不值）。文本提取的漂移风险由三重自检兜住：
 *      恰好五层 / 每层 include 非空 / 模式形态受 matchInclude 守卫。
 */
function readProjects(): Project[] {
  const text = readFileSync(join(ROOT, 'vitest.config.mts'), 'utf8');
  const projects: Project[] = [];
  const re = /name:\s*'(\w+)'[\s\S]{0,400}?include:\s*\[([^\]]*)\]/g;
  for (const m of text.matchAll(re)) {
    const include = [...m[2]!.matchAll(/'([^']+)'/g)].map((s) => s[1]!);
    projects.push({ name: m[1]!, include });
  }
  return projects;
}

/** include 模式的最小子集匹配器；不认识的形态抛错（= 形态扩展必须同步这里） */
function matchInclude(pattern: string, path: string): boolean {
  const body = (b: string): boolean =>
    b.startsWith('*') ? path.endsWith(b.slice(1)) : path.endsWith(`/${b}`) || path === b;
  if (pattern.startsWith('**/')) return body(pattern.slice(3));
  const idx = pattern.indexOf('/**/');
  if (idx >= 0) return path.startsWith(pattern.slice(0, idx + 1)) && body(pattern.slice(idx + 4));
  throw new Error(`匹配器不认识的 include 形态：${pattern}——扩展 matchInclude 或改回已知形态`);
}

function collectTestFiles(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, root, out);
    else if (/\.test\.(ts|js|mts)$/.test(entry.name)) out.push(relative(root, full));
  }
  return out;
}

describe('测试文件归属守卫：每个测试文件都属于五层之一', () => {
  const projects = readProjects();

  it('配置里恰好是 unit / db / contract / e2e / lint 五层（删层/改名会在这里先红）', () => {
    expect(projects.map((p) => p.name).sort()).toEqual(
      ['contract', 'db', 'e2e', 'lint', 'unit'].sort(),
    );
    for (const p of projects) expect(p.include.length).toBeGreaterThan(0);
  });

  it('全仓测试文件零孤儿：每个文件至少被一层 include 命中', () => {
    const files = collectTestFiles(ROOT, ROOT);
    expect(files.length).toBeGreaterThan(50); // 扫描器自检：全仓只扫到个位数 = 扫描器本身坏了
    const orphans = files.filter(
      (f) => !projects.some((p) => p.include.some((pat) => matchInclude(pat, f))),
    );
    expect(
      orphans,
      `孤儿测试文件（不属于任何 project、gate 不会跑）：\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('匹配器自检：能认出各层形态，也认得出孤儿', () => {
    const owned = (f: string) =>
      projects.some((p) => p.include.some((pat) => matchInclude(pat, f)));
    expect(owned('server/src/a/b/x.unit.test.ts')).toBe(true);
    expect(owned('test/e2e/deep/y.test.ts')).toBe(true);
    expect(owned('components/ws-button/index.unit.test.ts')).toBe(true);
    expect(owned('server/src/x.test.ts')).toBe(false); // 裸后缀 = 孤儿
    expect(owned('server/src/x.integration.test.ts')).toBe(false); // 自创后缀 = 孤儿
  });

  it('匹配器形态守卫：include 出现新形态必须抛错（提醒同步匹配器）', () => {
    // 单层 `*` 深度通配不在最小子集内（`src/＊/x` 的中间星号是一层，不是任意深度）
    expect(() => matchInclude('src/*/x.unit.test.ts', 'src/a/x.unit.test.ts')).toThrow(
      /不认识的 include 形态/,
    );
  });
});
