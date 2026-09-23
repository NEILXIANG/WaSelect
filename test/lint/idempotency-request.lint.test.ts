/**
 * 职责：把「幂等调用必须传 request 做指纹」从约定变成**会红的检查**（LM 层第三类，N3 的结构防线）。
 *
 * @why 二审 N3 证明了一件事：40908 指纹校验实现得再对，**唯一的调用方不传 request 它就是死代码**——
 *      机制与接线必须成对检查（§2 第 10 条复盘 2）。这条门禁守的就是接线：
 *      `withIdempotency(` / `withIdempotencyTx(` 的每个调用点，要么 args 里有 `request:`，
 *      要么在旁边写 `// idempotency-no-request: <理由>` 豁免（给"确实没有入参"的接口留口子）。
 *
 * @limitation 一：这是**文本扫描**不是 AST——它用"调用行之后的 40 行窗口里有没有 `request:`"来判断。
 *              窗口边界是启发式的：args 对象写在 40 行以外（极端排版）会误红，届时把窗口调大或改写法。
 *              误红（让你多看一眼）比漏绿（悄悄失去保护）便宜，所以窗口宁小勿大。
 * @limitation 二：豁免注释只要求"存在"，不审理由是否成立——理由质量靠 review（同注释门禁的 @limitation 一）。
 * @limitation 三：只扫 `server/src`。测试文件里的调用（如 db 测试故意不传 request 验证留口子行为）不受此约束。
 *
 * @see docs/二审意见甄别报告-2026-09-23.md §1 N3；server/src/idempotency.ts（request 参数的 @why）
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
  /** 调用行起 40 行窗口的文本（判断 request: 与豁免注释用） */
  window: string;
}

/** 匹配调用点，排除定义点与注释提及。 */
const CALL_RE = /\bwithIdempotency(?:Tx)?\s*\(/g;
/** 窗口行数：够覆盖"args 对象 + handler 头部"的常规排版 */
const WINDOW_LINES = 40;

function scan(): CallSite[] {
  const files = walk(join(root, 'server/src'))
    .filter((f) => extname(f) === '.ts')
    .filter((f) => !f.includes('.test.'));
  const sites: CallSite[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((text, i) => {
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(text)) !== null) {
        // 排除定义点（export async function withIdempotency(）与注释里的提及
        const before = text.slice(0, m.index);
        if (/\bfunction\b/.test(before)) continue;
        if (/\/\/|\/\*/.test(before)) continue;
        sites.push({
          rel: f.slice(root.length + 1),
          line: i + 1,
          window: lines.slice(i, i + WINDOW_LINES).join('\n'),
        });
      }
    });
  }
  return sites;
}

const sites = scan();

describe('幂等调用的指纹接线门禁（N3）', () => {
  it('扫描到至少一个调用点（否则下面的断言是假绿灯）', () => {
    // 一个调用点都没扫到 = 正则失效或目录改了，绝不能表现为"通过"
    expect(sites.length).toBeGreaterThan(0);
  });

  it('每个调用点都传了 request，或写了 idempotency-no-request 豁免理由', () => {
    const bad = sites.filter(
      (s) => !/\brequest\s*:/.test(s.window) && !s.window.includes('idempotency-no-request:'),
    );
    expect(
      bad,
      `这些幂等调用点没有传 request（指纹校验会是死代码，N3 重演），也没有豁免理由：\n` +
        bad.map((s) => `${s.rel}:${s.line}`).join('\n') +
        `\n修法：给 args 加 request: <请求素材>；确实没有入参的接口写 // idempotency-no-request: <理由>`,
    ).toEqual([]);
  });
});
