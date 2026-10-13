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
 *              其余 .js / .ts 只跑受影响的 + 全部守卫用例（三天提交复查 2026-10-12）。
 * @limitation 二：改动集合 = 相对 HEAD~1 的差异 + 暂存区 + 未跟踪文件（与原来 `--changed HEAD~1` 的口径一致，再补未跟踪）。
 * @see package.json test:fast；docs/测试缺口复盘-2026-10-12.md
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

/** 会被单测按内容读取、却不在 import 图里的文件类型。 */
export const SCANNED_ASSET_RE = /\.(css|wxss|wxml|md|json|ya?ml|sql)$/i;

/**
 * 小程序页面薄壳：壳用例按 URL 动态加载（test/helpers/mp-page.ts）、守卫按文字读取——都不在 import 图里。
 * @why 三天提交复查 2026-10-12：只改某页 index.js 时，那页的壳用例与 vm-guard / nav-param-guard 等一条不跑。
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
 * 按源码文字检查的守卫用例（`*guard*.unit.test.ts`）：快速测试每次都补跑。
 * @why 守卫读的是一批源文件（如 server/src/app/*.ts 的路由路径），改其中任何一个都不会通过 import 图找到守卫；
 *      守卫本身很快（读文件 + 正则），每次补跑的代价可以忽略（三天提交复查 2026-10-12）。
 * @returns {string[]}
 */
export function guardTestFiles() {
  return execFileSync('git', ['ls-files', '*guard*.unit.test.ts'], { encoding: 'utf8' })
    .split('\n')
    .filter((s) => s !== '');
}

/** @returns {string[]} 相对 HEAD~1 的改动 + 暂存区 + 未跟踪文件（去重）。 */
function changedFiles() {
  const lines = (args) =>
    execFileSync('git', args, { encoding: 'utf8' })
      .split('\n')
      .filter((s) => s !== '');
  return [
    ...new Set([
      ...lines(['diff', '--name-only', 'HEAD~1']),
      ...lines(['diff', '--name-only', '--cached']),
      ...lines(['ls-files', '--others', '--exclude-standard']),
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
  if ((r.status ?? 1) !== 0 || full) process.exit(r.status ?? 1);
  // 只跑受影响用例时，补跑守卫（它们不在 import 图里，见 guardTestFiles 的 @why）
  console.log('test:fast：补跑按源码文字检查的守卫用例');
  const g = spawnSync('npx', ['vitest', 'run', '--project', 'unit', ...guardTestFiles()], {
    stdio: 'inherit',
  });
  process.exit(g.status ?? 1);
}
