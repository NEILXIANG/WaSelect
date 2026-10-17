/**
 * 职责：自研变异测试的 CLI 入口（逻辑在 ./mutate-lib.ts）。
 *
 * 用法：
 *   npm run mutation                          # 默认：严格档纯函数模块（下方 TARGETS）
 *   npm run mutation -- --files server/src/domain/order.ts packages/shared/src/money.ts
 *   npm run mutation -- --break 70            # 总分低于 70 退出码 1（CI 用）
 * 报告写到 var/mutation/<时间>.md；最后一行是结论。
 *
 * @why 相关单测 = 同目录同名的 `*.unit.test.ts` + 仓库里 import 了该模块的其它 `*.unit.test.ts`（git grep）：
 *      域模块常由上层用例间接钉住（quote 由 quote-routes 的单测），只跑同名文件会把这些漏成"存活"。
 * @why 要求工作区里目标文件**干净**（git 无改动）才跑：变异是原地写文件再还原，中途被 Ctrl+C 时靠
 *      `git checkout -- <file>` 兜底；文件本来就有未提交改动的话这一兜底会把改动冲掉。
 * @limitation 每个变异起一次 vitest（约 3～6 秒）：默认目标几百个变异要几十分钟，别放进 gate。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { renderReport, runMutation, summarize } from './mutate-lib.js';

/** 默认目标：严格档里有纯函数单测的模块（与 vitest.coverage-gates 的 100% 名单同源，去掉只由 db 测试覆盖的适配器）。 */
const TARGETS = [
  'packages/shared/src/money.ts',
  'packages/shared/src/orderNo.ts',
  'server/src/domain/order-no.ts',
  'server/src/domain/order.ts',
  'server/src/domain/partial-refund.ts',
  'server/src/domain/quote.ts',
  'server/src/domain/shipping-fit.ts',
  'server/src/redact.ts',
  'server/src/review-window.ts',
];

function args(name: string): string[] {
  const i = process.argv.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j]!.startsWith('--'); j += 1)
    out.push(process.argv[j]!);
  return out;
}

const files = args('--files').length > 0 ? args('--files') : TARGETS;
const breakArg = args('--break')[0];
const breakBelow = breakArg === undefined ? null : Number(breakArg);
for (const f of files) {
  if (!existsSync(f)) {
    process.stderr.write(`找不到 ${f}\n`);
    process.exit(2);
  }
}
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], {
  encoding: 'utf8',
}).trim();
if (dirty !== '') {
  process.stderr.write(
    `目标文件有未提交改动，先提交或暂存再跑（变异要原地改文件再还原）：\n${dirty}\n`,
  );
  process.exit(2);
}

/** 该模块的相关单测文件（去重、存在的）。 */
function relatedTests(file: string): string[] {
  const base = basename(file, '.ts');
  const sibling = join(dirname(file), `${base}.unit.test.ts`);
  const r = spawnSync(
    'git',
    [
      'grep',
      '-l',
      '-E',
      `from '[./]+.*/${base}\\.js'|from '\\./${base}\\.js'`,
      '--',
      '*.unit.test.ts',
      '*.unit.test.tsx',
    ],
    { encoding: 'utf8' },
  );
  const importers = r.status === 0 ? r.stdout.split('\n').filter((l) => l !== '') : [];
  return [...new Set([sibling, ...importers])].filter((p) => existsSync(p));
}

const vitest = join('node_modules', '.bin', 'vitest');
const runTests = (file: string): boolean => {
  const tests = relatedTests(file);
  if (tests.length === 0) return true; // 没有相关单测 = 什么都抓不住，如实记为存活
  const r = spawnSync(vitest, ['run', '--project', 'unit', '--reporter=dot', ...tests], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
};

const startedAt = new Date().toISOString();
process.stdout.write(
  `变异测试：${String(files.length)} 个文件（相关单测按同名文件 + git grep 的引用方）\n`,
);
const restore = (): void => {
  for (const f of files) spawnSync('git', ['checkout', '--', f]);
};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
let results;
try {
  results = await runMutation(
    {
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, c) => writeFileSync(p, c),
      runTests,
      now: () => Date.now(),
      log: (l) => process.stdout.write(`${l}\n`),
    },
    files,
  );
} finally {
  restore();
}
mkdirSync('var/mutation', { recursive: true });
const report = renderReport(results, { startedAt, breakBelow });
const out = `var/mutation/${startedAt.replace(/[:.]/g, '-')}.md`;
writeFileSync(out, report);
const s = summarize(results);
process.stdout.write(`${report.split('\n').at(-1) ?? ''} → ${out}\n`);
process.exit(breakBelow !== null && s.score < breakBelow ? 1 : 0);
