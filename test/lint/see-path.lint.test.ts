/**
 * 职责：把「`@see` 里写的**全限定路径**必须真的存在」变成**会红的检查**（LM 层第三类）。
 *
 * @why 第五轮逐行复读 SEC 分片时发现 `adapters/identity.ts` 与 `app/auth.unit.test.ts`
 *      两处 `@see` 都指向 `server/src/auth.ts` —— 一个**不存在的路径**（鉴权骨架在 `app/` 下）。
 *      （本文件自己的注释里若要写坏路径当例子，必须写成"`@see` 指向 `xxx`"这种**不相邻**的形态，
 *        否则会被本门禁自己扫到——它就是这么工作的一次演示。）
 *      它不会让任何测试红，唯一的代价是"照它去找的人找不到，于是放弃核对"；
 *      而那两处指向的恰恰是最该被核对的约定（身份缓存 TTL、回源查什么）。
 *      与 SEC-13 那条同形：**"写在注释里"对"少写一个目录"这类缺陷的防护力是 0**。
 *
 * @why 只查**全限定**路径（以顶层目录开头且带扩展名），不查相对路径：
 *      相对路径的基准由读者自己决定（`app/auth.ts` 是相对 `server/src` 还是相对本文件？
 *      两种写法在本库都存在），机器判不了，硬判就是一堆误红——
 *      **误红多了门禁就会被加豁免，门禁随即失效**（`idempotency-request.lint.test.ts` 的教训）。
 *      全限定路径没有歧义，所以这一半可以做到零误报（实测 129 条命中、2 条坏链、0 误报）。
 *
 * @limitation 一：只扫 `.ts` / `.tsx`。`docs/` 下的**审查报告**不扫——它们是某个时点的记录，
 *              报告里引用当时的路径本身就是史料，改它会篡改历史；要防的是**活文档**（源码注释）里的断链。
 * @limitation 二：认不出"路径 + 后面紧跟中文"以外的排版（例如 `@see` 后面换行再写路径）。
 *              认不出的结果是漏检而不是误红；真要覆盖就改这里的正则。
 * @limitation 三：只验**文件存在**，不验"这个文件里确实有被 @see 指到的那个符号"。
 *              后者要解析 AST，代价大得多；路径对了已经能消灭绝大多数"找不到"的情形。
 * @limitation 四：顶层目录白名单是**枚举**的。新顶层目录要加进来，否则会静默漏检——
 *              漏检由下面第一条"至少命中 N 条"兜住一部分（总数骤降会红）。
 *
 * @see docs/自主决策记录.md AJ-349
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/** 顶层目录白名单（@limitation 四）。 */
const TOP_DIRS = [
  'server/',
  'docs/',
  'migrations/',
  'test/',
  'admin-web/',
  'scripts/',
  'contracts/',
  'miniprogram/',
  'packages/',
  'deploy/',
] as const;

/** 只有带扩展名的才像"文件路径"，否则可能是文档标题（如 `@see docs/可扩展架构设计`）。 */
const EXT_RE = /\.(ts|tsx|mts|sql|md|json|mjs|js|yaml|yml)$/;

/** `@see ` 后面第一个非空片段（中文括号 / 顿号 / 分号都算分隔符）。 */
const SEE_RE = /@see\s+([^\s（(，,、；;]+)/g;

/**
 * @why 必须显式排掉 `node_modules`：`@waselect/server` 是**指向 `server/src` 的符号链接**，
 *      而 `statSync` 会跟随链接 ⇒ 同一个文件被扫两遍（实测：注入一次断链，报告里出现
 *      `node_modules/@waselect/…` 与 `server/src/…` **两条**）。重复本身只是噪音，
 *      真正的问题是它会让"命中总数"随依赖安装情况抖动。
 *      ⚠️ 这一条是**实测**发现的（第一次跑红灯时才看见），不是预先想到的。
 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

interface Ref {
  rel: string;
  line: number;
  target: string;
}

function scan(): Ref[] {
  const files = walk(root)
    .filter((f) => extname(f) === '.ts' || extname(f) === '.tsx')
    // dist / 构建产物里的重复副本不算（它们也不该有注释，但保险起见）
    .filter((f) => !f.includes('/dist/'));
  const refs: Ref[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        SEE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = SEE_RE.exec(text)) !== null) {
          const target = (m[1] ?? '').replace(/[`.,]+$/, '');
          if (!TOP_DIRS.some((d) => target.startsWith(d))) continue;
          if (!EXT_RE.test(target)) continue;
          refs.push({ rel, line: i + 1, target });
        }
      });
  }
  return refs;
}

const refs = scan();

describe('@see 全限定路径不得断链（AJ-349）', () => {
  it('扫描到足够多的引用（否则下面那条断言是假绿灯）', () => {
    // 命中数骤降 = 正则或白名单失效，绝不能表现为"通过"
    expect(refs.length).toBeGreaterThan(50);
  });

  it('每条全限定路径都真的存在', () => {
    const bad = refs.filter((r) => !existsSync(join(root, r.target)));
    expect(
      bad,
      `这些 @see 指向不存在的文件 —— 照它去找的人会找不到，于是放弃核对：\n` +
        bad.map((r) => `${r.rel}:${r.line} → ${r.target}`).join('\n'),
    ).toEqual([]);
  });
});
