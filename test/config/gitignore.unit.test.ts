/**
 * 职责：`.gitignore` 对**环境变量文件**的覆盖面（DB-15）。
 *
 * @why 2026-09-29 首轮审查（DB-15）实测：只忽略 `.env` / `.env.local` / `.env.*.local`，
 *      而 `.env.production` 与 `.env.staging` **不在名单里**——`git check-ignore` 无输出。
 *      本仓**有 staging**（render.yaml 里就有 staging 服务），`.env.staging` 装的恰恰是
 *      staging 的真密钥：Stripe 测试密钥、R2 密钥、JWT_SECRET。
 *      这类缺口是**静默**的：`git add` 一个不被忽略的文件没有任何提示，
 *      等发现时密钥已经在远端历史里——删文件救不回来，只能全部轮换。
 *      所以这里钉住两个方向，而不是只钉一个：
 *        ① 各种 `.env<后缀>` 都要被忽略（补上漏掉的环境后缀）；
 *        ② `.env.example` **不能**被忽略（它是模板、必须入库）。
 *      ②是①的必然副作用：修①最省事的写法是 `.env*`，一旦写错顺序或漏掉 `!` 取反，
 *      `.env.example` 自己反而进不了库——那时"配置模板消失"会以"新机器跑不起来"的形式暴露，
 *      比密钥泄漏温和，但同样是回归，同样该在门禁里红。
 *
 * @how 直接问 git（`git check-ignore`），不自己解析 `.gitignore` 的语法。
 *      @why gitignore 的语义（目录递归、`!` 取反的顺序、末尾斜杠、转义）自己实现一遍
 *          必然与 git 有偏差，而偏差的方向一定是"以为忽略了其实没有"——
 *          守卫自己不可靠比没有守卫更糟：它给人虚假的安全感。
 *      @limitation 依赖本机有 `git` 且当前目录在仓库内（门禁与 CI 都满足）；
 *                  被查的路径**不需要真实存在**，`git check-ignore` 只按规则判定。
 * @see .gitignore、render.yaml（staging 服务）、test/config/render-env.unit.test.ts
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

/**
 * 这个路径是否会被 git 忽略。
 *
 * @why 用退出码而不是 stdout：`git check-ignore -q` **不打印**被忽略的路径，
 *      只在"没匹配到"时退出 1；靠输出判断会得出"输出为空 = 被忽略"这个**反的结论**。
 * @why ⚠️ 必须带 `--no-index`（本守卫最初就是栽在这里，实测）：
 *      `git check-ignore` **默认会查索引**，已经在版本控制里的路径一律报"未被忽略"——
 *      而 `.env.example` 恰恰是**已入库**的模板。于是"`.env*` 忘了写 `!.env.example`"这一侧
 *      永远测不出来：注入该缺陷后守卫照样是绿的（见 §2 自欺清单）。
 *      加 `--no-index` 之后判定的就是**纯 .gitignore 规则**，与文件当前是否被跟踪无关——
 *      这也正是我们要守卫的东西：规则本身对不对，而不是"这个文件现在碰巧已经被 add 了"。
 * @limitation 抛错只可能来自 git 本身不可用（不是"没被忽略"）——把它当成环境问题抛出，
 *              不要 `return false`，否则 git 装不上时守卫会静默变成"全都合法"。
 */
function ignored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', relPath], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (e) {
    const code = (e as { status?: number }).status;
    if (code === 1) return false;
    throw e;
  }
}

describe('.gitignore 的环境变量覆盖面（DB-15）', () => {
  it('🔴 每一种环境的 .env 文件都被忽略（含曾经漏掉的 production / staging）', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.staging',
      '.env.development',
      '.env.test',
      '.env.something.local',
    ]) {
      expect(ignored(name), `${name} 应该被忽略但没有——密钥会进远端历史`).toBe(true);
    }
  });

  it('🔴 .env.example 不能被忽略（它是模板、必须入库）', () => {
    // @why 与上一条成对：只钉"都要忽略"的话，`.env*` 写错的最省事写法会连模板一起吃掉。
    expect(ignored('.env.example')).toBe(false);
  });

  it('普通文件不受影响（通配没有写宽到把别的东西也盖住）', () => {
    expect(ignored('README.md')).toBe(false);
    expect(ignored('package.json')).toBe(false);
  });
});
