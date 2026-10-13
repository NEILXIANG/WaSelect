#!/usr/bin/env node
/**
 * 职责：`npm run test:fast`（提交钩子 gate:fast 的一步）——平时只跑受改动影响的 unit 用例；
 *      改动里有**被单测按文件内容读取**的非模块文件（css / wxss / wxml / md / json / yaml / sql）时，跑全部 unit 用例；
 *      无论改动是什么，都再固定跑一遍按内容读源码（.ts/.tsx/.js/.mjs/.cts）的 shape tests。
 *
 * @why 原来是 `vitest run --changed HEAD~1`：vitest 按 **import 关系**找受影响的用例。设计令牌检查
 *      （admin-web/src/design-token.unit.test.ts）、小程序页面壳 / wxml 用例、文档一致性用例都是用 fs 读文件，
 *      不在 import 图里——只改 css 时它们一条都不跑。2026-10-12 实测：4ef8991 给 app.css 写了 `3px`，
 *      提交钩子全绿，设计令牌用例在 main 上是红的，到下一次全量才发现（测试缺口复盘 2026-10-12）。
 * @why 2026-10-13 又发现：`.ts` / `.js` 源码本身也会被按内容读（`server/src/adapters/admin-auth.unit.test.ts:140`：
 *      `readFileSync(new URL('../app/admin-auth-routes.ts', import.meta.url))`），只改 `admin-auth-routes.ts`
 *      时 `--changed` 照样挑不到它。修法是再跑一遍**所有按内容读源码的 unit test**（动态扫出来，不维护名单）。
 * @tradeoff 改一行 css 也要跑全部 unit（约一分钟，比原来慢）；换来的是"按内容读文件"的那几十条用例不再被跳过。
 *           只扩到 unit：db / e2e 不读这类文件，仍交给全量 gate。
 * @limitation 一：按扩展名判，不分析哪个用例读了哪个文件——宁可多跑。小程序页面薄壳（pages/<页>/index.js）同样跑全部；
 *              （三天提交复查 2026-10-12：页面壳用例按 URL 动态加载，不在 import 图里）。
 *              按源码文字检查的守卫用例由 gate:fast 的 test:guards 每次全跑，这里不重复。
 * @limitation 二：改动集合 = 相对 HEAD~1 的差异 + 暂存区 + 未跟踪文件（与原来 `--changed HEAD~1` 的口径一致，再补未跟踪）。
 * @limitation 三：动态扫描靠**源码文本里的 `readFileSync(` 第一个参数**判断是否读源码。若参数是变量/模板串拼出来的
 *              （如 `readFileSync(`${root}/${name}`)`），本扫描无法静态确定目标扩展名，会误判为"不是 shape test"。
 *              这属于"宁可少跑一个 shape test，也不宁可每次跑全量"的取舍；目前 18 个 shape test 都能被识别。
 * @see package.json test:fast；docs/测试缺口复盘-2026-10-12.md
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
 *      `"docs/\\350\\207\\252\\344\\270\\273…\\345\\275\\225.md"`——**带引号 + 八进制转义**。于是
 *      `SCANNED_ASSET_RE` 的 `\\.md$` 永远匹配不到（那个字符串以 `"` 结尾），"改动里有被单测按内容读取的文件
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

/**
 * 按顶层括号/引号切分字符串（不会切到括号/引号内部）。
 * @why 取 `readFileSync(...)` 的第一个参数文本；参数里可能嵌套 `new URL('...', import.meta.url)` 这类括号。
 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i += 1;
        i += 1;
      }
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** 从 `(` 处取到配对的 `)`。 */
function callText(src, openParen) {
  let depth = 0;
  let i = openParen;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
    i += 1;
  }
  return src.slice(openParen + 1);
}

/** 会被按内容读取的源码扩展名：这些文件改动后，`--changed` 的 import 图挑不到读它的用例。 */
const SHAPE_SOURCE_EXTS = /\.(ts|tsx|js|mjs|cts)(?![\w])/i;

/**
 * 扫描所有 unit test 文件，找出用 `readFileSync` 读 .ts/.tsx/.js/.mjs/.cts 源码的 shape tests。
 * @returns {string[]} 相对仓库根的路径
 * @measured 2026-10-13：本仓共 18 个（含 `.claude/sim-local` 下的临时文件 2 个，被过滤掉后 16 个）。
 */
export function contentReadingTests() {
  const files = gitPaths(['ls-files', '-z', '*.unit.test.ts', '*.unit.test.tsx']);
  const tests = [];
  for (const f of files) {
    if (!f || f.startsWith('.claude/')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\breadFileSync\s*\(/g)) {
      const args = splitTopLevel(callText(src, m.index + 'readFileSync('.length - 1));
      if (args.length > 0 && SHAPE_SOURCE_EXTS.test(args[0])) {
        tests.push(f);
        break;
      }
    }
  }
  return tests;
}

if (isMain(import.meta.url, process.argv[1])) {
  const full = needsFullUnit(changedFiles());
  const shapeTests = contentReadingTests();

  if (full) {
    console.log(
      'test:fast：改动里有被单测按内容读取的文件（css / wxss / wxml / md / json …）→ 跑全部 unit 用例',
    );
    const r = spawnSync('npx', ['vitest', 'run', '--project', 'unit'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  console.log('test:fast：先跑受改动影响的 unit 用例');
  const r1 = spawnSync(
    'npx',
    ['vitest', 'run', '--project', 'unit', '--changed', 'HEAD~1', '--passWithNoTests'],
    { stdio: 'inherit' },
  );
  if (r1.status !== 0) process.exit(r1.status ?? 1);

  if (shapeTests.length > 0) {
    console.log(`test:fast：再固定跑 ${String(shapeTests.length)} 个按内容读源码的 shape tests`);
    const r2 = spawnSync('npx', ['vitest', 'run', '--project', 'unit', ...shapeTests], {
      stdio: 'inherit',
    });
    process.exit(r2.status ?? 1);
  }

  process.exit(0);
}
