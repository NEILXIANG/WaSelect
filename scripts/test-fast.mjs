#!/usr/bin/env node
/**
 * 职责：`npm run test:fast`（提交钩子 gate:fast 的一步）——平时只跑受改动影响的 unit 用例；
 *      改动里有**被单测按文件内容读取**的非模块文件（css / wxss / wxml / md / json / yaml / sql）时，跑全部 unit 用例。
 *
 * @why 原来是 `vitest run --changed HEAD~1`：vitest 按 **import 关系**找受影响的用例。设计令牌检查
 *      （admin-web/src/design-token.unit.test.ts）、小程序页面壳 / wxml 用例、文档一致性用例都是用 fs 读文件，
 *      不在 import 图里——只改 css 时它们一条都不跑。2026-10-12 实测：4ef8991 给 app.css 写了 `3px`，
 *      提交钩子全绿，设计令牌用例在 main 上是红的，到下一次全量才发现（测试缺口复盘 2026-10-12）。
 * @tradeoff 改一行 css 也要跑全部 unit（约一分钟，比原来慢）；换来的是"按内容读文件"的那几十条用例不再被跳过。
 *           只扩到 unit：db / e2e 不读这类文件，仍交给全量 gate。
 * @limitation 一：按扩展名判，不分析哪个用例读了哪个文件——宁可多跑。小程序页面薄壳（pages/<页>/index.js）同样跑全部；
 *              （三天提交复查 2026-10-12：页面壳用例按 URL 动态加载，不在 import 图里）。
 *              按源码文字检查的守卫用例由 gate:fast 的 test:guards 每次全跑，这里不重复。
 * @limitation 二：改动集合 = 相对 HEAD~1 的差异 + 暂存区 + 未跟踪文件（与原来 `--changed HEAD~1` 的口径一致，再补未跟踪）。
 * @limitation 三：**同一个洞还剩一半没堵**。上面两条规则都是按**扩展名 / 路径模式**猜"这个文件会不会被单测按内容读"，
 *              而 `.ts` / `.js` **源码本身**也会被按内容读：源码形状用例
 *              （`server/src/adapters/admin-auth.unit.test.ts:140`：`readFileSync(new URL('../app/admin-auth-routes.ts', import.meta.url))`）
 *              读的就是实现原文。只改这样一个 `.ts`、且改动集里没有别的资源文件时，`--changed` 照样挑不到读它的用例。
 *              实测"改动文件的 basename 出现在某个测试源码里"这个判据**不可用**：450 个生产源码里 309 个（68.7%）
 *              的名字在测试里出现过（等于每次都跑全量）。所以真正的选择只有两个——把 `--changed` 整个去掉、永远跑全量
 *              （+约 45 秒），或者明确接受这个洞。本轮只修了**路径引号**那一半（它是可证的、且已经真的漏过一次），
 *              另一半留给人拍板：@see docs/自主决策记录.md AJ-523。
 * @see package.json test:fast；docs/测试缺口复盘-2026-10-12.md
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

/** 会被单测按内容读取、却不在 import 图里的文件类型。 */
export const SCANNED_ASSET_RE = /\.(css|wxss|wxml|md|json|ya?ml|sql)$/i;

/**
 * 小程序页面薄壳：壳用例按 URL 动态加载（test/helpers/mp-page.ts），不在 import 图里。
 * @why 三天提交复查 2026-10-12：只改某页 index.js 时，那页的壳用例一条不跑（守卫由 test:guards 全跑，不受影响）。
 * @measured 2026-10-12：在 miniprogram/pages/cart/index.js 末尾加一行注释后跑
 *           `vitest run --project unit --changed --passWithNoTests --reporter=verbose`，只跑了 scripts/test-fast.unit.test.ts
 *           （另一处未提交改动），cart 的壳用例与 vm 用例都没跑。
 */
export const MP_PAGE_SHELL_RE = /^miniprogram\/pages\/.+\/index\.js$/;

/**
 * 改动里有没有"按内容读取"或"动态加载"的文件。
 * @param {readonly string[]} files 相对仓库根的路径
 * @returns {boolean}
 */
export function needsFullUnit(files) {
  return files.some((f) => SCANNED_ASSET_RE.test(f) || MP_PAGE_SHELL_RE.test(f));
}

/**
 * git 路径分隔符：给每条 `--name-only` / `ls-files` 都加 `-z`，路径用 NUL 分隔（**原样**输出）。
 *
 * @why 不能用默认输出。`core.quotePath` 默认为 true（本仓没有关掉它），非 ASCII 路径会被写成
 *      `"docs/\350\207\252\344\270\273…\345\275\225.md"`——**带引号 + 八进制转义**。于是
 *      `SCANNED_ASSET_RE` 的 `\.md$` 永远匹配不到（那个字符串以 `"` 结尾），"改动里有被单测按内容读取的文件
 *      → 跑全部 unit"这条安全网对**中文名文件静默失效**。本仓的文档几乎全是中文名
 *      （`docs/自主决策记录.md`、`docs/地基搭建清单.md`…），而 `.md` / `.yaml` 恰恰就在被扫的集合里。
 * @measured 2026-10-13：`needsFullUnit(['docs/自主决策记录.md'])` 为 `true`，把同一个文件换成 git 默认输出的
 *      那一串（引号 + 八进制）则为 **`false`**。
 * @real 34c5a41（改了 `docs/自主决策记录.md` 与几个 `.ts`，改动集里**没有** ASCII 资源文件）就是这样把一条
 *      红的"源码文本断言"带进了 main：安全网没触发 → 走 `--changed` → 那条 `readFileSync` 读文件的用例不在 import
 *      图里、一条没跑。**同一改动集里只要有一个 ASCII 资源文件就会照出来**——批次 6 改
 *      `contracts/api-contract.yaml` 时正是如此（这才发现了它）。@see docs/自主决策记录.md AJ-523
 */
const NUL = '\0';

/** 跑一条 git 命令，把 `-z` 输出按 NUL 切成路径（导出以便单测钉住"非 ASCII 路径原样保留"）。 */
export function parseNulPaths(raw) {
  return raw.split(NUL).filter((s) => s !== '');
}

/** 同上，直接跑命令。 */
function gitPaths(args) {
  return parseNulPaths(execFileSync('git', args, { encoding: 'utf8' }));
}

/** @returns {string[]} 相对 HEAD~1 的改动 + 暂存区 + 未跟踪文件（去重）。 */
export function changedFiles() {
  return [
    ...new Set([
      ...gitPaths(['diff', '--name-only', '-z', 'HEAD~1']),
      ...gitPaths(['diff', '--name-only', '-z', '--cached']),
      ...gitPaths(['ls-files', '-z', '--others', '--exclude-standard']),
    ]),
  ];
}

if (isMain(import.meta.url, process.argv[1])) {
  const full = needsFullUnit(changedFiles());
  const args = full
    ? ['vitest', 'run', '--project', 'unit']
    : ['vitest', 'run', '--project', 'unit', '--changed', 'HEAD~1', '--passWithNoTests'];
  console.log(
    full
      ? 'test:fast：改动里有被单测按内容读取的文件（css / wxss / wxml / md / json …）→ 跑全部 unit 用例'
      : 'test:fast：只跑受改动影响的 unit 用例',
  );
  const r = spawnSync('npx', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
