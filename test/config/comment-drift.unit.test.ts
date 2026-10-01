/**
 * 职责：**过时注释**的复发守卫（ADM3-07）。
 *
 * @why 第三轮审查发现同一句"理由"在三处文件头反复写着「vitest 的 unit 层是 node 环境，
 *      没有 jsdom / 没有组件测试 harness」，而 `admin-web/src/testing/dom.ts` 落地后它早已不是事实。
 *      注释与事实分离本身就是 bug（ADR-29）——它会让下一个人**照着错的理由做对的决定**，
 *      也会让"这条纪律还有没有必要"无法讨论（讨论的前提是理由是真的）。
 *      改完一次不设防，同一句会像上次一样被复制到第四处（这次就已经多了一处：覆盖率配置）。
 *
 * @why 用**黑名单短语**扫源码，而不是只盯那四个文件：
 *      漂移的传染方式就是"复制到新文件"，只盯原地的守卫挡不住它。
 *
 * @limitation 一：只扫 `ROOTS`（管理端源码 + 两个测试配置），**不做全仓扫描**。
 *      @why 全仓扫描实测 ~3s（2000+ 文件），会撞上 unit 层默认的 5s 测试超时——
 *      在机器忙的那一轮里它自己会变成**假红灯**（2026-10-01 实测：全仓版与另一条仓库扫描守卫
 *      `business-events.unit.test.ts` 在满载那一轮双双 timeout，单跑各自都绿）。
 *      而这句过时理由的复制路径恰恰就是这两处（文件头 → 邻近文件头 → 配置文件），
 *      扫它们已经覆盖了漂移的真实方向；真被复制到别处，靠评审兜。
 * @limitation 二：只拦这几条**已经证伪**的具体说法，不做通用"注释是否与实现一致"的判断——
 *              那是语义判断，脚本做不到。新增证伪的说法时把它加进 `STALE` 即可。
 * @limitation 三：明写"订正"的那一行放行（它在**记录**旧说法，不是在使用它）——
 *              否则"改注释"与"记录改过什么"互相打架，最后没人敢写订正理由。
 *
 * @see admin-web/src/testing/dom.ts（jsdom 组件用例宿主）；vitest.coverage-gates.ts（覆盖率口径）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');

/** 扫描范围（见 @limitation 一）。 */
const ROOTS = [
  join(ROOT, 'admin-web/src'),
  join(ROOT, 'vitest.coverage-gates.ts'),
  join(ROOT, 'vitest.config.mts'),
];

/** 已经证伪的说法 → 命中即红（第二项是给人看的"应该说成什么"）。 */
const STALE: ReadonlyArray<readonly [string, string]> = [
  ['没有 jsdom', 'jsdom 组件用例由 admin-web/src/testing/dom.ts 提供（*.dom.unit.test.ts）'],
  ['没有组件测试 harness', 'harness 已存在，组件用例只是成本比纯函数高'],
  ['未引入 testing-library', '刻意不引第三方库，自研 harness 三十行够用'],
  ['没有 jsdom / React Testing Library', '同上'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

function* walk(p: string): Generator<string> {
  if (statSync(p).isFile()) {
    if (/\.(ts|tsx|mts)$/.test(p)) yield p;
    return;
  }
  for (const name of readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(p, name));
  }
}

/** 命中的过时说法（相对路径 + 行号 + 行内容）。 */
function hits(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('订正')) return; // @limitation 三
        for (const [phrase] of STALE) {
          if (line.includes(phrase)) {
            out.push(`${relative(ROOT, file)}:${String(i + 1)} 「${line.trim()}」`);
            break;
          }
        }
      });
    }
  }
  return out;
}

describe('注释不得重复已证伪的说法（ADM3-07）', () => {
  it('🔴 管理端与测试配置里不再出现"没有 jsdom / 没有组件测试 harness"这类过时理由', () => {
    expect(hits()).toEqual([]);
  });

  it('🔴 jsdom 组件用例的宿主仍在（守卫的前置事实被删了，上面那条就成了空门禁）', () => {
    const host = join(ROOT, 'admin-web/src/testing/dom.ts');
    expect(readFileSync(host, 'utf8')).toContain('jsdom');
  });
});
