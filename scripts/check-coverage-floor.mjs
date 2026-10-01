/**
 * 职责：覆盖率**逐文件下限**——统计范围内每个文件的行覆盖率都不得低于底线（gate 最后一步，跟在 `cov` 之后）。
 *
 * @why 第三轮审查 TST3-03：阈值表只有全局 85 与关键模块 100 两档。全局是**汇总**比较，
 *      实测（2026-09-30 的 coverage-summary.json，171 个文件）还能再吸收 367 个零覆盖分支 / 737 行
 *      而不跌破 85%——新写一个几百行、零测试的路由，gate 照样绿。当时就有两个现成的例子：
 *      `admin-web/src/api/endpoints.ts`（管理端登录，0%）与 `server/src/app/cleanup-idempotency.ts`（33%）。
 *      约束一"无测试不前进"在机器层面因此只剩关键模块名单那 40 余个文件。
 * @why 不用 vitest 的 `perFile: true`：它会把全局 85 也变成逐文件要求，现有十几个文件立刻红，
 *      逼人去写凑数测试；而 glob 键的阈值是**对匹配集合汇总**比较，同样防不住单个零覆盖文件。
 *      底线取 60（行）/ 50（分支）：@measured（同一份产物）除上面两个文件外最低是 85 行 / 50 分支，
 *      这条线只拦"几乎没测"，不拦"测得不够细"——后者仍由全局与关键模块阈值管。
 * @why 读 `coverage/coverage-summary.json`（`vitest.config.mts` 的 json-summary 报告器）而不是自己算：
 *      与全局阈值同一份数据，不会出现"两个口径各说各的"。
 *
 * @limitation 一：只在 `cov` 之后有意义；单独跑会读到上一次的产物（过期数据）。所以只挂在 gate 里、紧跟 cov。
 * @limitation 二：豁免必须写原因（{@link EXEMPT}）；没有原因的豁免会让机制失效（约束九）。
 * @tradeoff 60 是底线不是目标：一个文件从 95 掉到 61 这里看不见——那是全局阈值与 review 的事。
 *
 * @see vitest.coverage-gates.ts；test/config/coverage-floor.unit.test.ts；docs/自主决策记录.md AJ-246
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const FLOOR = { lines: 60, branches: 50 };

/** 豁免：路径（相对仓库根）→ 原因。当前为空。 */
export const EXEMPT = {};

/**
 * @param {Record<string, {lines:{pct:number,total:number}, branches:{pct:number,total:number}}>} summary
 * @param {string} root 仓库根的绝对路径（summary 的键是绝对路径）
 * @returns {string[]} 违规描述；空数组 = 通过
 */
export function coverageFloorViolations(summary, root, floor = FLOOR, exempt = EXEMPT) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const out = [];
  for (const [abs, m] of Object.entries(summary)) {
    if (abs === 'total') continue;
    const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    if (Object.hasOwn(exempt, rel)) continue;
    // 没有可执行行 / 分支的文件（纯类型、纯常量）pct 记为 100，天然通过
    if (m.lines.total > 0 && m.lines.pct < floor.lines)
      out.push(`${rel}：行 ${m.lines.pct}% < ${floor.lines}%`);
    if (m.branches.total > 0 && m.branches.pct < floor.branches)
      out.push(`${rel}：分支 ${m.branches.pct}% < ${floor.branches}%`);
  }
  return out.sort();
}

// 作为脚本直接运行时才执行（被测试 import 时不执行）
if (isMain(import.meta.url, process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(root, 'coverage', 'coverage-summary.json');
  if (!existsSync(file)) {
    console.error(`\n✗ 找不到 ${file}——先跑 npm run cov\n`);
    process.exit(1);
  }
  const bad = coverageFloorViolations(JSON.parse(readFileSync(file, 'utf8')), root);
  if (bad.length > 0) {
    console.error(
      `\n✗ 以下文件低于逐文件覆盖率底线（行 ${FLOOR.lines}% / 分支 ${FLOOR.branches}%）：\n  ${bad.join('\n  ')}\n`,
    );
    process.exit(1);
  }
  console.log(`✔ 逐文件覆盖率底线（行 ${FLOOR.lines}% / 分支 ${FLOOR.branches}%）全部满足`);
}
