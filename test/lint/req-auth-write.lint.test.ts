/**
 * 职责：把"`req.auth` **只有** `requireRole` 能写"从评审约定变成**会红的检查**（LM 层第三类）。
 *
 * @why `express-augment.d.ts` 的 @limitation 写的是"约定只有 `requireRole` 会写它，
 *      代码评审时把 `req.auth =` 当作红线"。但 `req.auth` 是**全局**增强：
 *      任何路由都能写它，而下游（`req.auth?.sub`）一律**相信**它——
 *      于是"某个路由自己塞一个 `req.auth`"就是**凭空造一个身份**，
 *      比"忘了挂守卫"更隐蔽：守卫看着是挂了的，只是身份是它自己写的。
 *      这类缺陷不产生任何错误信号（类型允许、测试若不专门打这条路径也全绿），
 *      "靠 review"对它的防护力取决于当天 reviewer 记不记得这条约定。
 *
 * @why 允许**测试文件**写它：`admin-audit.unit.test.ts` 等要用它模拟"已过守卫"的请求，
 *      那是被测行为的**输入**，不是被测代码在伪造身份。
 *
 * @limitation 一：这是**文本扫描**不是 AST，只认 `req.auth =` 这种直接赋值。
 *              `Object.assign(req, { auth })` / `res.locals` 中转 / `req['auth'] =`
 *              这类间接写法**管不到**——它们都需要 AST 或运行时拦截。
 *              挡住"顺手写一句"这一种形态已经消灭了绝大多数真实发生的情况
 *              （凭空造身份通常就是一行直白的赋值，不是精心设计的间接引用）。
 * @limitation 二：**只扫代码行，跳过注释行**（`//` / `*` / `/*` 开头）。
 *              ⚠️ 这一条是实测逼出来的：第一版没跳过，`express-augment.d.ts` 的 @limitation
 *              里那句"把 `req.auth =` 当作红线"**自己**被扫成违规（它正是在描述这个写法）。
 *              注释里出现被禁的写法是正常的（说明文档需要引用它），代码里出现才是违规。
 * @limitation 三：允许"中间件所在文件"整体写（`server/src/app/auth.ts`），
 *              不精确到"必须在这个函数里"：同文件里另一个函数写也放过。
 *              精确到函数要按行号区间维护，行号一漂就误红；按文件已经把范围从
 *              "全库"缩到"一个 300 行的鉴权文件"，误放的空间很小。
 *
 * @see docs/自主决策记录.md AJ-351；server/src/express-augment.d.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/** 唯一允许写 `req.auth` 的非测试文件（`requireRole` 所在处）。 */
const ALLOWED_REL = 'server/src/app/auth.ts';

/** `req.auth =` / `req.auth=`，排除 `==` / `===`（后两者不是赋值）。 */
const WRITE_RE = /req\.auth\s*=(?!=)/g;

interface Hit {
  rel: string;
  line: number;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function scan(): Hit[] {
  const files = walk(root)
    .filter((f) => extname(f) === '.ts' || extname(f) === '.tsx')
    .filter((f) => !f.includes('/dist/'))
    // 测试文件允许：它写的是"已过守卫"这个**输入**
    .filter((f) => !f.includes('.test.'));
  const hits: Hit[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1);
    if (rel === ALLOWED_REL) continue;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        // 注释行不算（@limitation 二：说明文档需要引用这个写法）
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
        WRITE_RE.lastIndex = 0;
        if (WRITE_RE.test(text)) hits.push({ rel, line: i + 1 });
      });
  }
  return hits;
}

const hits = scan();

describe('req.auth 的写入点（AJ-351）', () => {
  it('扫描器认得到它该认的那个写入点（否则下面那条是假绿灯）', () => {
    // @why 用"允许清单里的文件确实含这个写法"来证明正则没失效：
    //      只断言"违规数为 0"的话，正则写错 ⇒ 永远 0 ⇒ 永远绿。
    const allowed = readFileSync(join(root, ALLOWED_REL), 'utf8');
    expect(WRITE_RE.test(allowed)).toBe(true);
  });

  it('除 requireRole 所在文件与测试文件外，没有任何一处写 req.auth', () => {
    expect(
      hits,
      `这些地方自己写了 req.auth —— 下游一律相信它，等于凭空造一个身份：\n` +
        hits.map((h) => `${h.rel}:${h.line}`).join('\n') +
        `\n修法：身份只能由 server/src/app/auth.ts 的 requireRole 写入；` +
        `确实需要新写入点的话，改本门禁的 ALLOWED_REL 并说明为什么。`,
    ).toEqual([]);
  });
});
