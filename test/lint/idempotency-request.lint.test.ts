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
 * @limitation 四：**实现文件本身不算调用点**（`server/src/adapters/idempotency.ts`）：
 *              它内部的 `withIdempotency(db, args, handler)` 只是把工厂转发给实现，不是业务调用。
 *              ⚠️ 这是按**路径**排除的：哪天这个文件被搬走，排除会失效、本门禁会红——
 *              红在这里是好事（比静默漏检好），修法是同步改这里的路径。
 *
 * @see docs/二审意见甄别报告-2026-09-23.md §1 N3；server/src/ports/idempotency.ts（request 参数的 @why）
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
  /** 整个文件的行（回溯「本调用点属于哪条路由」用） */
  lines: string[];
}

/**
 * 匹配调用点，排除定义点与注释提及。
 *
 * 两种形态都要认：
 * - `idempotency.run(InTx)?(` —— **端口形态**，业务侧今后唯一应该用的写法（R2-1 之后）；
 * - `withIdempotency(Tx)?(` —— 旧的函数式写法，适配器内部转发仍在用它。
 *
 * @why 只认旧写法会在端口化之后**静默漏检**（业务改走 `deps.idempotency.runInTx`，
 *      扫描器一个调用点都找不到 → 第一条断言"至少扫到一个"会红，但那是"扫描器失效"
 *      而不是"接线断了"，信号是歪的）；只认新写法则会漏掉还没端口化的老调用点。
 * @limitation `idempotency.run` 前缀是**按命名约定**匹配的：若有人把字段命名成
 *              `idempotencyExecutor.run(...)`（没有 `idempotency` 紧邻），这里就匹配不到。
 *              约定成本极低（装配处就是这么注入的），但要知道它靠的是约定不是 AST。
 */
const CALL_RE = /\b(?:withIdempotency(?:Tx)?|idempotency\.run(?:InTx)?)\s*\(/g;
/** 窗口行数：够覆盖"args 对象 + handler 头部"的常规排版 */
const WINDOW_LINES = 40;

/** 实现文件本身不是调用点（见文件头 @limitation 四）。 */
const IMPL_REL = 'server/src/adapters/idempotency.ts';

function scan(): CallSite[] {
  const files = walk(join(root, 'server/src'))
    .filter((f) => extname(f) === '.ts')
    .filter((f) => !f.includes('.test.'));
  const sites: CallSite[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    if (rel === IMPL_REL) continue;
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
          rel,
          line: i + 1,
          window: lines.slice(i, i + WINDOW_LINES).join('\n'),
          lines,
        });
      }
    });
  }
  return sites;
}

const sites = scan();

/**
 * 调用点**属于哪条路由**：从调用行向上回溯最近的一处 `app.<method>('<path>'`。
 *
 * @why 必须按**路由**判断而不是按"文件里有没有 `req.params`"：
 *      `order-routes.ts` 里有 `GET /orders/:id` 读路径参数，但它的幂等调用点在
 *      `POST /orders`（无路径参数）上——按文件判断会**误红**，误红多了就会被加豁免、门禁随即失效。
 * @limitation 取"调用点之前最近的那一处"是启发式：一个文件里路由交错排版时会认错归属。
 *             认错的代价是误红（多看一眼），比漏绿便宜；真误红了就调整排版或加豁免理由。
 */
function routePathAbove(lines: string[], callLineIdx: number): string {
  for (let i = callLineIdx; i >= 0; i -= 1) {
    const text = lines[i] ?? '';
    // §2 第 54 条：注释里的同款字符串不算——注释掉的路由注册不是路由
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    // ⚠️ 不能匹配 `app.post(` 那一行：**路径字面量在它的下一行**（prettier 的排版），
    //    按行匹配 `app.post\(\s*'` 永远拿不到 → 这条断言会静默假绿（第一次写就是这样）。
    const m = /'(\/api\/v1\/[^']*)'/.exec(text);
    if (m !== null) return m[1] ?? '';
  }
  return '';
}

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

  /**
   * B10 / AJ-195：带路径参数的幂等路由，指纹不得是**裸 `req.body`**。
   *
   * @why 幂等键的作用域只由「用户 + 路由 + 客户端键」拼成，`route` 是**常量**，
   *      不含 `/orders/{id}/pay` 里的 id。**指纹若只有裸 body**，同一把键用在另一个资源上
   *      会被判成"同键同参" → 重放**另一个资源**的响应：
   *      copylink 拼出「上一张单的金额 + 这一张单的短链」，in_app 直接把上一张单的会话
   *      交给正在付这一单的人。A5 让客户端键变成复用之后，这条从"潜伏"变为可达。
   * @limitation 只挡**裸 `req.body`** 这一种写法。`request: { channel: body['channel'] }`
   *            这种"只取 body 字段"的形态同样漏路径参数，但文本上分辨不出来——
   *            那条只能靠 review 与行为用例（pay-intent-routes.db.test.ts 有真库用例守着：
   *            去掉指纹里的 order_id 它会红）。
   */
  it('带路径参数的幂等路由，指纹不得是裸 req.body（B10 / AJ-195）', () => {
    const bad = sites
      .filter((s) => routePathAbove(s.lines, s.line - 1).includes(':'))
      .filter(
        (s) =>
          /\brequest:\s*req\.body\b/.test(s.window) &&
          !s.window.includes('idempotency-raw-body-ok:'),
      );
    expect(
      bad,
      `这些幂等路由带路径参数、指纹却是裸 body（跨资源重放，B10）：\n` +
        bad
          .map((s) => `${s.rel}:${s.line}（路由 ${routePathAbove(s.lines, s.line - 1)}）`)
          .join('\n') +
        `\n修法：request: { <路径参数>, ...(body ?? {}) }；确实无关的接口写 // idempotency-raw-body-ok: <理由>`,
    ).toEqual([]);
  });
});
