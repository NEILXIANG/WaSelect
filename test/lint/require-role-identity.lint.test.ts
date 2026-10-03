/**
 * 职责：把「`requireRole` 必须接身份检查（D25）」从注释约定变成**会红的检查**（LM 层第三类）。
 *
 * @why SEC-13 上一轮只改了注释（`auth.ts` 里写"生产装配一律传"），**没有任何东西在守它**：
 *      一个路由只要写 `requireRole('admin', deps.auth)`，编译照样过、测试照样绿，
 *      而后果是**封禁 / 改密 / 撤权要等 token 自然过期（管理员 12 小时）才生效**——
 *      这正是 D25 存在的全部理由（JWT 验签通过 ≠ 这个人现在还能用）。
 *      这类缺陷的特征是"少传一个可选参数"，它不产生任何错误信号，
 *      只能靠"有人记得"来防——而"记得"在第六个月一定失效。
 *
 * @why 光有类型**不够**，所以本门禁与类型各守一半：
 *      - 类型（各 `XxxRoutesDeps.identity` 已改为必填）守住"**装配处**忘了传"；
 *      - 本门禁守住"**路由内部**没把 `deps.identity` 交给 `requireRole`"
 *        ——那一半类型管不到：`identity` 必填但没人用它，TS 不会报错。
 *      两者缺一，洞就还在。
 *
 * @limitation 一：这是**文本扫描**不是 AST——用"调用行起 6 行窗口里有没有 `identity:`"判断。
 *              6 行够覆盖 prettier 对 `{ identity: deps.identity }` 的常见排版；
 *              极端换行会误红，误红（多看一眼）比漏绿（悄悄失去保护）便宜。
 * @limitation 二：只扫 `server/src` 的**非测试**文件。`auth.unit.test.ts` 里刻意不传 identity
 *              的用例是在测"不传就不查库"这个既定行为（`requireRole` 的第三参保持可选正是为它），
 *              它们不受此约束。
 * @limitation 三：不认豁免注释。与 `idempotency-request.lint.test.ts` 不同——那里"确实没有入参"
 *              是合法形态；这里**没有任何生产形态**应该关掉身份回源检查，留豁免口子等于留洞。
 *
 * @see docs/自主决策记录.md AJ-347；server/src/app/auth.ts（`requireRole` 的 `@param identity`）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

interface CallSite {
  rel: string;
  line: number;
  window: string;
}

/** 匹配 `requireRole(` 调用点；`function requireRole(` 是定义点，靠 `before` 里的 `function` 排除。 */
const CALL_RE = /\brequireRole\s*\(/g;
/** 窗口行数：`requireRole(\n  'user',\n  deps.auth,\n  { identity: deps.identity },\n)` 的常规排版 */
const WINDOW_LINES = 6;

function scan(): CallSite[] {
  const files = walk(join(root, 'server/src'))
    .filter((f) => extname(f) === '.ts')
    .filter((f) => !f.includes('.test.'));
  const sites: CallSite[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((text, i) => {
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(text)) !== null) {
        const before = text.slice(0, m.index);
        if (/\bfunction\b/.test(before)) continue;
        if (/\/\/|\/\*/.test(before)) continue;
        sites.push({
          rel,
          line: i + 1,
          window: lines.slice(i, i + WINDOW_LINES).join('\n'),
        });
      }
    });
  }
  return sites;
}

const sites = scan();

describe('requireRole 的身份回源接线门禁（SEC-13 / AJ-347）', () => {
  it('扫描到至少一个调用点（否则下面那条断言是假绿灯）', () => {
    // 一个都没扫到 = 正则失效或目录改名，绝不能表现为"通过"
    expect(sites.length).toBeGreaterThan(0);
  });

  it('每个调用点都把 identity 交给了 requireRole', () => {
    const bad = sites.filter((s) => !/\bidentity\s*:/.test(s.window));
    expect(
      bad,
      `这些 requireRole 调用点没传 identity —— 封禁 / 改密 / 撤权要等 token 自然过期才生效，\n` +
        `而且没有任何行为用例会红（这是 SEC-13 当年只改了注释的原因）：\n` +
        bad.map((s) => `${s.rel}:${s.line}`).join('\n') +
        `\n修法：第三个参数传 { identity: deps.identity }；装配点见 server/src/app/mount.ts。`,
    ).toEqual([]);
  });
});
