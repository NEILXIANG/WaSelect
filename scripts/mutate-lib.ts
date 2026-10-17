/**
 * 职责：自研的小型变异测试——往源码里逐个注入"小错"（翻比较符、换逻辑符、翻布尔），跑对应单测，
 * 数有多少个错被抓住。纯逻辑在这里（生成变异、编排、报告），文件读写与跑测试由入口注入。
 *
 * @why 不用 Stryker（2026-10-16 实测，@measured）：装了 @stryker-mutator/core + vitest-runner 10.0.0（peerDep 声明 vitest >=2），
 *      在本仓 vitest 5.0.1 下三种配置都跑不出结果——① 默认 related 模式选中的是 db 用例、unit 用例没被选上，
 *      "整个函数体删空"的变异也存活且 "Ran 0.00 tests per mutant"；② 换成只含 unit 的专用配置后同样 0 覆盖 0 击杀；
 *      ③ 关掉 related 则沙盒里的初始测试就有失败用例（沙盒复制整仓后部分用例的相对路径 / git 读取不成立）。
 *      要修得去改它对 vitest 5 的适配，不如写一份 150 行的：本仓本来就有"缺陷注入"纪律（约束八），这只是把它机械化。
 * @why 变异算子只取**最能暴露假断言**的几种：比较符方向、等号、逻辑与或、布尔字面量、取反。
 *      四天提交复查抓到的"反向断言永远为真"、OPS3-06 的"按行数还是按去重计数"都属这几类；
 *      字符串字面量、数值字面量不动（文案归轻量档，常量另有单测钉值）。
 * @why 逐行文本替换而不是 AST：被变异的都是 300 行以内的纯函数文件，行内只换**被空格包围**的运算符，
 *      注释行与 import 行跳过；误伤字符串里的运算符会表现为"该变异导致语法 / 类型错误 → 测试红 → 记为 killed"，
 *      会把分数略微抬高，不会漏报真正的存活。@limitation 一就是这一条。
 * @limitation 一：没有 AST，分不清字符串里的 ` && `；只保证不漏报存活。
 * @limitation 二：一次只注入一个变异、跑一遍相关单测——每个变异要起一次 vitest（约 3～6 秒），
 *              9 个文件几百个变异要几十分钟；放每周 CI，不进 gate。
 * @limitation 三：只跑 unit 项目；由 db 测试覆盖的分支（适配器层）这里看不到。
 * @see scripts/mutate.ts；docs/真平台验收清单.md 附录；.github/workflows/mutation.yml
 */

export interface Mutant {
  /** 1 起的行号 */
  line: number;
  /** 算子说明，如 `=== → !==` */
  operator: string;
  /** 变异后的整份源码 */
  source: string;
}

/** 变异算子：[匹配, 替换, 说明]。匹配要求运算符两侧是空格（prettier 口径），避免命中 `=>`、`<=` 的一部分。 */
const OPERATORS: readonly [RegExp, string, string][] = [
  [/ === /, ' !== ', '=== → !=='],
  [/ !== /, ' === ', '!== → ==='],
  [/ <= /, ' < ', '<= → <'],
  [/ >= /, ' > ', '>= → >'],
  [/ < /, ' <= ', '< → <='],
  [/ > /, ' >= ', '> → >='],
  [/ && /, ' || ', '&& → ||'],
  [/ \|\| /, ' && ', '|| → &&'],
  [/\btrue\b/, 'false', 'true → false'],
  [/\bfalse\b/, 'true', 'false → true'],
  [/\(!([A-Za-z_$][\w$.]*)/, '($1', '去掉取反 !'],
];

/** 这一行要不要跳过：注释、import、type 声明——改了也不是"业务判断错了"。 */
function skipLine(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('import ') ||
    t.startsWith('export type ') ||
    t.startsWith('type ') ||
    t.startsWith('interface ')
  );
}

/**
 * 为一份源码生成全部变异（每个变异只改一处）。
 * @why 同一行同一算子只取**第一次**命中：一行里 `a === b && c === d` 会产出 `===→!==`（第一处）与 `&&→||` 两个变异，
 *      不穷举第二个 `===`——穷举让数量翻倍而发现能力几乎不增。
 */
export function generateMutants(source: string): Mutant[] {
  const lines = source.split('\n');
  const out: Mutant[] = [];
  lines.forEach((line, i) => {
    if (skipLine(line)) return;
    for (const [re, rep, operator] of OPERATORS) {
      if (!re.test(line)) continue;
      const mutatedLine = line.replace(re, rep);
      if (mutatedLine === line) continue;
      const copy = lines.slice();
      copy[i] = mutatedLine;
      out.push({ line: i + 1, operator, source: copy.join('\n') });
    }
  });
  return out;
}

export interface MutationResult {
  file: string;
  line: number;
  operator: string;
  /** killed = 相关单测红了（抓住了）；survived = 全绿（没抓住） */
  status: 'killed' | 'survived';
  ms: number;
}

export interface MutationDeps {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  /** 跑这个源文件的相关单测；返回 true = 全绿 */
  runTests: (file: string) => boolean;
  now: () => number;
  log: (line: string) => void;
}

/**
 * 对一组文件逐个变异、跑测、还原。**每个文件结束时必还原**（finally），中途抛错也不会把变异留在盘上。
 * @param files 相对仓库根的源码路径
 */
export async function runMutation(
  deps: MutationDeps,
  files: readonly string[],
): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  for (const file of files) {
    const original = deps.readFile(file);
    const mutants = generateMutants(original);
    deps.log(`${file}：${String(mutants.length)} 个变异`);
    try {
      for (const m of mutants) {
        deps.writeFile(file, m.source);
        const t0 = deps.now();
        const green = deps.runTests(file);
        const r: MutationResult = {
          file,
          line: m.line,
          operator: m.operator,
          status: green ? 'survived' : 'killed',
          ms: deps.now() - t0,
        };
        results.push(r);
        deps.log(`  ${r.status === 'killed' ? '✓' : '✗ 存活'} L${String(m.line)} ${m.operator}`);
      }
    } finally {
      deps.writeFile(file, original);
    }
    await Promise.resolve();
  }
  return results;
}

export interface MutationSummary {
  total: number;
  killed: number;
  /** 0～100，一位小数 */
  score: number;
  perFile: { file: string; total: number; killed: number; score: number }[];
}

export function summarize(results: readonly MutationResult[]): MutationSummary {
  const pct = (k: number, t: number): number => (t === 0 ? 100 : Math.round((k / t) * 1000) / 10);
  const files = [...new Set(results.map((r) => r.file))];
  const perFile = files.map((file) => {
    const rs = results.filter((r) => r.file === file);
    const killed = rs.filter((r) => r.status === 'killed').length;
    return { file, total: rs.length, killed, score: pct(killed, rs.length) };
  });
  const killed = results.filter((r) => r.status === 'killed').length;
  return { total: results.length, killed, score: pct(killed, results.length), perFile };
}

/** Markdown 报告：总分、逐文件、存活清单（存活的才要人看）。最后一行是结论，便于 `tail -1`。 */
export function renderReport(
  results: readonly MutationResult[],
  o: { startedAt: string; breakBelow: number | null },
): string {
  const s = summarize(results);
  const survived = results.filter((r) => r.status === 'survived');
  const lines = [
    '# 变异测试报告',
    '',
    `- 时间：${o.startedAt}`,
    `- 总分：${String(s.score)}%（${String(s.killed)} / ${String(s.total)} 被抓住）`,
    '',
    '| 文件 | 变异数 | 抓住 | 分数 |',
    '|---|---|---|---|',
    ...s.perFile.map(
      (f) => `| ${f.file} | ${String(f.total)} | ${String(f.killed)} | ${String(f.score)}% |`,
    ),
    '',
    `## 存活的变异（${String(survived.length)}）`,
    '',
    ...(survived.length === 0
      ? ['（无）']
      : survived.map((r) => `- ${r.file}:${String(r.line)} ${r.operator}`)),
    '',
    o.breakBelow !== null && s.score < o.breakBelow
      ? `mutation FAILED: score ${String(s.score)}% < ${String(o.breakBelow)}%`
      : `mutation ok: score ${String(s.score)}%${o.breakBelow === null ? '（未设阈值，只出报告）' : ` ≥ ${String(o.breakBelow)}%`}`,
  ];
  return lines.join('\n');
}
