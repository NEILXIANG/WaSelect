/**
 * 职责：把「40301 这个码有多个成因，'是不是被拉黑'只能由一处判」从约定变成**会红的检查**。
 *
 * @why 40301（`FORBIDDEN`）在服务端**至少有五种成因**（`packages/shared/src/errors.ts` 只登记码与 action，
 *      不含 `reason`，所以从码上看不出是哪一种）：
 *      - `blocked`（`server/src/app/auth.ts`）——账号被拉黑：用户自己那一侧的事，重试永远不会成功；
 *      - `origin_not_verified`（`server/src/http.ts`，源站校验中间件只接受经 Cloudflare 的流量）——
 *        **买家同样碰得到**，那是一次基础设施故障，重试在故障修好后是有效的；
 *      - `not_admin` / `admin_totp_required`（管理端）、角色·受众不符（`auth.ts`，不带 reason）。
 *      小程序原先在**五处**各写一份 `code === 40301`（`utils/error-text.js`、`pages/checkout/index.vm.js` 两处、
 *      `pages/cart/index.vm.js` 两处），于是 CF 头注入一坏，**全体买家**读到"账号已被限制使用"、
 *      重试按钮被撤掉、错误态出口换成客服——而客服那边查不出任何问题（规律①：修一处不扫同类；
 *      规律②：同一条规则有多份实现）。
 *      收口后判据只剩一处（`isAccountBlocked`），这条门禁就是防止它悄悄扩散回去。
 *
 * @limitation 一：这是**文本扫描**不是 AST，而且**只扫 `miniprogram/` 下的 `.js`**。
 *              服务端与后台有自己的错误码表（`errors.ts` 是那里唯一真源），管理端没有"买家被拉黑"这件事；
 *              `.wxml` / `.json` 里出现 40301 只可能是注释（不参与判断），所以不扫。
 *              漏检的形态：把码存进常量再引用（`const F = 40301` 之后 `code === F`）——
 *              本门禁认 `40301` 这个字面量，换个名字就绕过了。绕过的代价由"这一处必须自己判成因"兜着。
 * @limitation 二：豁免注释只要求"存在"，不审理由是否成立（同其它注释门禁）；
 *              识别窗口是"本行往前两行内"，写得太远（≥3 行）会误红——误红只是多看一眼，比漏检便宜。
 * @limitation 三：第二条用例只检查 `isBlocked` 的**函数体里出现了 `reason`**，不解析表达式。
 *              它挡的是最省事的那种退化（把判据改回 `err.code === 40301`），挡不住
 *              "读了 reason 但比较的是错的字符串"——那一侧由 `error-text.unit.test.ts` 的行为用例钉。
 *
 * @see miniprogram/utils/error-text.js（isAccountBlocked：唯一判据）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
/** 唯一允许出现 40301 源码字面量的文件（判据的实现处）。 */
const OWNER = 'miniprogram/utils/error-text.js';
/** 40301 的码值（本文件必须写出它——否则这条门禁自己就没法找它了）。 */
const FORBIDDEN_CODE_TEXT = '40301';
/** 豁免注释（确实需要在别处引用这个码时用）。 */
const EXEMPT = 'forbidden-code-literal-ok:';
/** 不扫的目录：宿主产物与依赖。 */
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', 'dist', '.git']);

/** 列出 miniprogram 下所有 `.js` 源码（不含测试：`*.test.*` 在 TypeScript / 不在本 glob 内）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    // 只扫 .js 源码：.ts 是小程序侧的测试与工具链，.wxml/.json 里的 40301 只可能是注释
    if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 去掉 `//` 行注释与 `/* … *\/` 块注释，**保留换行**（行号因此不变）。
 *
 * @why 本项目大量在 JSDoc 里引用历史写法（"本文件原先写 `code === 40301`"），
 *      只按 `//` 切会把这些说明当成违规。既然要认，就老老实实做一遍词法状态机
 *      （`//` 出现在字符串里——例如 URL——不能当注释起始）。
 * @limitation 不解析正则字面量里的 `/`；本项目 `miniprogram/**` 下没有"以 / 开头且含 40301"的正则。
 */
function stripComments(src: string): string[] {
  const out: string[] = [];
  let line = '';
  let inBlock = false;
  let inLine = false;
  let quote = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') {
      out.push(line);
      line = '';
      inLine = false;
      continue;
    }
    if (inLine) continue;
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote !== '') {
      if (c === '\\') {
        line += c + (next ?? '');
        i += 1;
        continue;
      }
      if (c === quote) quote = '';
      line += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true; // 行注释：本行剩余丢掉（⚠️ 只丢本行，不是丢掉整个文件）
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    line += c;
  }
  out.push(line);
  return out;
}

describe('40301 的成因判断只能有一处（多因码不得照码判）', () => {
  it(`🔴 ${OWNER} 之外，miniprogram 的源码里不再出现 ${FORBIDDEN_CODE_TEXT} 这个字面量`, () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(root, 'miniprogram'))) {
      const rel = relative(root, file);
      if (rel === OWNER) continue;
      const lines = stripComments(readFileSync(file, 'utf8'));
      lines.forEach((line, i) => {
        if (!line.includes(FORBIDDEN_CODE_TEXT)) return;
        // 豁免：本行、或本行往前两行内（同 idempotency-request / form-number-normalize 门禁的"窗口"做法）
        if ([line, lines[i - 1] ?? '', lines[i - 2] ?? ''].some((l) => l.includes(EXEMPT))) return;
        offenders.push(`${rel}:${String(i + 1)} ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `${FORBIDDEN_CODE_TEXT} 有多个成因（被拉黑 / 源站校验失败…），照码判会把基础设施故障说成"你的账号有问题"。` +
        `用 utils/error-text.js 的 isAccountBlocked(err)（页面把结果作为布尔往下传）；` +
        `确实要在别处引用这个码时，写 \`// ${EXEMPT} <理由>\``,
    ).toEqual([]);
  });

  it('🔴 唯一判据自身读的是 reason（不是把"凡 40301"当被拉黑）', () => {
    const src = readFileSync(resolve(root, OWNER), 'utf8');
    // 取 isBlocked 的函数体：从 `function isBlocked(` 起，按大括号配对到函数结束
    const at = src.indexOf('function isBlocked(');
    expect(at, `${OWNER} 里找不到 isBlocked（判据被改名或删了）`).toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(open, end + 1);
    expect(
      body.includes('reason'),
      'isBlocked 必须比对 `data.reason`（只有 blocked 才是"账号被拉黑"）。' +
        '把判据退回"凡 40301 皆被拉黑"会让源站校验失败时的全体买家被告知"账号已被限制使用"',
    ).toBe(true);
  });
});
