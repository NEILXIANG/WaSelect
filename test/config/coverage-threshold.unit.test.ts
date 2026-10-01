/**
 * 职责：断言**每一条"按文件设的覆盖率阈值"都还命中真实文件**（阈值表在 `vitest.coverage-gates.ts`）。
 *
 * @why 这是"门禁的门禁"，起因是一次真实的静默失效（2026-09-24 发现）：
 *      R2-1 把 `auth.ts` 搬进 `app/`、`webhooks.ts` 搬进 `adapters/` 之后，
 *      `coverage.thresholds` 里那两条键仍按老路径写着。vitest 对"匹配不到任何文件的阈值"
 *      **既不报错也不生效**——全局 85% 还在，`npm run gate` 照旧绿，
 *      于是"webhooks 必须 100%"这条本项目最硬的约束**悄悄消失了**，而没人会收到任何信号。
 *      这类失效比阈值写错更危险：它表现为"我明明设了门禁"，实际门是开着的。
 *
 * @how 直接从配置里取出 `thresholds` 的所有键，逐个拿去匹配磁盘上的真实源文件，
 *      断言至少命中一个。验的是"键还指向文件"，不是"覆盖率达标"——后者是 vitest 自己的职责。
 *
 * @limitation 一：只能防"路径写错/文件搬走"，防不住"阈值数值被调低"
 *              （比如把 100 改成 60）。后者是**有意为之**的改动，属于 review 范畴，
 *              用断言钉死数值只会逼人把测试一起改掉，反而失去信号。
 * @limitation 二：自带的 glob 匹配器只支持 `**` `*` `?` 三种语法（够用），
 *              不是完整 glob 实现——所以文件里对匹配器自身也做了断言（见最后一条用例）：
 *              验证脚本自己有 bug 是最难发现的一类假绿。
 * @limitation 三：放在 unit 层（而不是 lint 层）是为了让它在**提交时**就能拦住。
 *              ⚠️ 原来写"进 `npm run test:fast` 就能拦住"不成立（第三轮审查 TST3-04）：
 *              `test:fast` 是 `--changed`，而本测试读文件、不 import 被守的源码，搬走 auth.ts 时它不会被选中。
 *              现在由提交钩子里固定的 `npm run test:guards`（`test/config` 整目录）保证它每次提交都跑。
 *
 * @see vitest.coverage-gates.ts（阈值唯一事实来源）；docs/自主决策记录.md AJ-46
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EXCLUDE,
  COVERAGE_INCLUDE,
  COVERAGE_THRESHOLDS,
} from '../../vitest.coverage-gates.js';

const root = resolve(import.meta.dirname, '../..');

/** 阈值里表示"全局底线"的键——它们不是文件路径，不参与"是否命中文件"的断言。 */
const GLOBAL_KEYS = new Set([
  'lines',
  'functions',
  'branches',
  'statements',
  'perFile',
  'autoUpdate',
  '100',
]);

/** 直接从唯一事实来源取，不再二次解析 vitest.config.mts（后者由 esbuild 加载，不便被测试引用）。 */
const coverage = {
  include: COVERAGE_INCLUDE as string[],
  exclude: COVERAGE_EXCLUDE as string[],
  thresholds: COVERAGE_THRESHOLDS as Record<string, unknown>,
};

/** 递归列出仓库内的源文件（跳过 node_modules / dist / coverage / 点目录）。 */
function listFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在：不抛，交给下面的断言去红
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (statSync(full).isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/**
 * 最小 glob → 正则：只支持 `**`（跨目录）、`*`（段内通配）、`?`（单字符）。
 * @why 不引第三方 glob 库：这里只需要能匹配"配置里那几种路径写法"，
 *      引库等于为三条断言增加一个依赖一个版本风险；代价是语法不全，已在 @limitation 二写明。
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  // 用 charAt 而不是 `glob[i]`：项目开了 noUncheckedIndexedAccess，下标取值是 `string | undefined`
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        // `**/` 吃掉任意层目录（含 0 层）；行尾的 `**` 等价于 `.*`
        if (glob.charAt(i + 2) === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += '\\^$.|+()[]{}'.includes(c) ? `\\${c}` : c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

const allFiles = listFiles(root);

/** 按配置的 include/exclude 取"参与统计的源文件"（与 vitest 的口径保持一致）。 */
function coveredSourceFiles(): string[] {
  const include = (coverage.include ?? []).map(globToRegExp);
  const exclude = (coverage.exclude ?? []).map(globToRegExp);
  if (include.length === 0) return [];
  return allFiles.filter(
    (f) => include.some((re) => re.test(f)) && !exclude.some((re) => re.test(f)),
  );
}

describe('覆盖率阈值配置（vitest.coverage-gates.ts）', () => {
  it('配置读得到 coverage.thresholds（改了配置结构会在这里红，而不是静默全绿）', () => {
    expect(coverage, '没读到 test.coverage——配置结构变了？').toBeDefined();
    expect(coverage.thresholds, 'coverage.thresholds 不见了').toBeDefined();
    expect(coverage.include, 'coverage.include 不见了（统计范围都没了）').toBeDefined();
  });

  it('全局底线四项（lines/functions/branches/statements）都还在且是数字', () => {
    const t = coverage.thresholds ?? {};
    for (const key of ['lines', 'functions', 'branches', 'statements'] as const) {
      expect(typeof t[key], `全局 ${key} 阈值丢了或被改成了非数字`).toBe('number');
    }
  });

  /**
   * 核心断言：每一条"按文件"的阈值键必须命中至少一个真实存在的源文件。
   * @why 命中 0 个 = 这条阈值**根本没生效**，而 vitest 不会给任何提示。
   *      这正是 auth.ts / webhooks.ts 搬目录之后真实发生过的事。
   */
  it('每条按文件设的阈值键都命中 ≥1 个真实源文件（防止文件搬走后阈值静默失效）', () => {
    const files = coveredSourceFiles();
    expect(files.length, '参与统计的源文件一个都没匹配上——include 写错了？').toBeGreaterThan(0);

    const perFileKeys = Object.keys(coverage.thresholds ?? {}).filter((k) => !GLOBAL_KEYS.has(k));
    expect(perFileKeys.length, '一条按文件的阈值都没有——是不是被整体删掉了？').toBeGreaterThan(0);

    for (const key of perFileKeys) {
      const re = globToRegExp(key);
      const hit = files.filter((f) => re.test(f));
      expect(
        hit.length,
        `阈值键「${key}」匹配不到任何源文件：这条阈值当前**不生效**。` +
          `常见原因是文件被搬走了但这里的路径没跟着改（R2-1 已踩过一次）`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * 匹配器自检。
   * @why 见 §2 诚实清单第 6 条：验证脚本自己有 bug 是最难发现的一类假绿——
   *      上面那条断言若因为匹配器写错而"什么都匹配不到"，表现是"全绿但一条阈值都没验"。
   * @measured 三条正例一条反例：'a/**\/*.ts' 命中 0 层与 2 层目录，'*' 不跨 '/'，'?' 只吃一个字符。
   */
  it('每个页面 view-model（miniprogram/pages/*/index.vm.js）都在统计范围内（约束十一的逻辑不能游离在门槛外）', () => {
    // @why 一致性审计 C6（AJ-176）：约束十一把页面逻辑全部挪进 *.vm.js，但 include 只收 utils，
    //      9 个 vm（约 750 行）不在任何覆盖率门槛下，《测试策略》§4.2「抽出的纯逻辑 ≥ 80%」形同虚设。
    //      新建页面时 vm 会自动进统计；有人删掉 include 那一行会在这里红。
    const vms = allFiles.filter((f) => /^miniprogram\/pages\/[^/]+\/index\.vm\.js$/.test(f));
    expect(vms.length).toBeGreaterThan(0);
    const covered = new Set(coveredSourceFiles());
    expect(vms.filter((f) => !covered.has(f))).toEqual([]);
  });

  it('自带 glob 匹配器自检：`**` 跨目录、`*` 不跨目录、`?` 单字符', () => {
    expect(globToRegExp('server/src/**/webhooks.ts').test('server/src/adapters/webhooks.ts')).toBe(
      true,
    );
    expect(globToRegExp('packages/shared/src/**/*.ts').test('packages/shared/src/money.ts')).toBe(
      true,
    );
    expect(globToRegExp('packages/shared/src/**/*.ts').test('packages/shared/src/a/b.ts')).toBe(
      true,
    );
    expect(globToRegExp('**/*.test.ts').test('server/src/a/b.test.ts')).toBe(true);
    // 反例：`*` 不该跨目录——否则 exclude 会把所有深层文件一起排除掉
    expect(globToRegExp('packages/*.ts').test('packages/shared/src/money.ts')).toBe(false);
    expect(globToRegExp('a?c.ts').test('abc.ts')).toBe(true);
    expect(globToRegExp('a?c.ts').test('ac.ts')).toBe(false);
  });
});
