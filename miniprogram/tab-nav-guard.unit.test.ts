/**
 * 职责：跳转 API 与**目标页是不是 tabBar 页**必须匹配（MP-02 / AJ-366）。
 *
 * @why 2026-10-05 逐行读支付页时实际踩到：`onGoHome` 与 `onViewOrders` 用
 *      **`redirectTo`** 跳 `/pages/home/index` 与 `/pages/order/index`——
 *      而这两个页 S5 之后都是 **tabBar 页**。小程序里 `navigateTo` / `redirectTo`
 *      **都跳不了 tabBar 页**（宿主直接拒绝），只有 `switchTab` 能跳。
 *      表现是**"点了没反应"**：不是报错，不是白屏，是按钮看起来好好的、
 *      按下去什么都不发生——本项目认定的最坏形态。
 *      ⚠️ 其中"查看订单"是 copylink（银行卡）场景下用户**唯一的退路**：
 *      他已经在浏览器里付完钱了，回来想看订单，按钮是死的。
 *
 * @why 做成扫描型守卫而不是只改那两行：tabBar 的**成员会变**（S5 就把订单从
 *      "我的页里的入口"升成了独立 tab），成员一变，所有指向它的旧跳转**同时失效**，
 *      而失效形态是静默的（没有测试会红、没有日志会打）。
 *      这正是 `nav-param-guard` 处理的那一类"两个文件之间的口头约定"。
 *
 * @limitation 一：只认 `wxApi.<api>({ url: … })` 这一种写法（全仓目前只有这一种）。
 *              直接写 `wx.switchTab` 会被 ESLint 的 `no-restricted-globals` 拦，所以没有第二种形态。
 *              url 的取值只认三种形态：模板串、引号串、标识符常量（`const X = '/pages/…'`）。
 * @limitation 二：`custom-tab-bar/index.js` 里的 `switchTab({ url: path })` **静态解析不了**
 *              ——`path` 来自 `tabBar.list` 自身，天然就是 tab 页，用 switchTab 也天然正确。
 *              它是唯一一条被豁免的；豁免**写成了带理由的白名单 `DYNAMIC_ALLOWED`**，
 *              并且白名单长度与"该文件未解析条数"都有上限，防止白名单被当成垃圾桶。
 * @limitation 三：只判**跳转方式**，不判页面是否真的在 `pages` 里注册
 *              （那是 `nav-param-guard` 与小程序编译期的职责，不重复做）。
 *
 * @see ../../app.json（tabBar.list 是"哪些页是 tab 页"的唯一真源）；
 *      ./utils/wx-api.js @limitation 十三/十四（switchTab 的语义与限制）；
 *      ./nav-param-guard.unit.test.ts（同族的另一条守卫）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MP = resolve(import.meta.dirname, '.');

/** `tabBar.list` 里的页（去掉前导 `/`）。改动它的是 app.json，不是本文件。 */
function tabPages(): Set<string> {
  const raw = readFileSync(join(MP, 'app.json'), 'utf8');
  const list = JSON.parse(raw).tabBar?.list ?? [];
  return new Set(
    (list as Array<{ pagePath?: string }>)
      .map((t) => String(t.pagePath ?? '').replace(/^\//, ''))
      .filter((p) => p !== ''),
  );
}

/**
 * url 只取一个"值 token"：模板串 / 引号串 / 标识符。
 * @why 第一版写成 `url:\s*([^,\n]+)`，把行尾的 ` });` 一起吞进了捕获组，
 *      于是 11 条本来能解析的跳转全部变成"未解析"（`EDIT_PAGE });` 不是标识符）。
 *      这是**静默失效**：未解析会被跳过，守卫看起来还在跑，其实什么都没查。
 */
const API_RE =
  /wxApi\.(navigateTo|redirectTo|switchTab)\(\{[\s\S]{0,200}?url:\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)/g;
const CONST_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g;

/**
 * 允许"静态解析不了"的文件 —— 必须给出理由，且每个文件最多豁免 1 条。
 * @why 见 @limitation 二。白名单的目的是**让漏检显形**，不是掩盖它。
 */
const DYNAMIC_ALLOWED: Array<{ file: string; why: string }> = [
  { file: 'custom-tab-bar/index.js', why: 'url 取自 tabBar.list 自身，天然是 tab 页' },
];

interface Jump {
  file: string;
  line: number;
  api: string;
  page: string | null;
  raw: string;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function scan(): Jump[] {
  const consts = new Map<string, string>();
  for (const f of walk(MP)) {
    const text = readFileSync(f, 'utf8');
    CONST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONST_RE.exec(text)) !== null) {
      const [, name, value] = m;
      if (name !== undefined && value !== undefined) consts.set(name, value);
    }
  }

  const out: Jump[] = [];
  for (const f of walk(MP)) {
    const text = readFileSync(f, 'utf8');
    API_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = API_RE.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      const api = m[1] ?? '';
      const expr = (m[2] ?? '').trim();
      let target: string | null = null;
      if (expr.startsWith('`')) {
        // 模板串：只看 `?` 之前的**路径段**（查询参数里的 `${id}` 与目标页无关），
        // 把路径段里的 `${CONST}` 换成常量的字面值；换不动就认解析不了。
        let ok = true;
        const filled = (expr.slice(1, -1).split('?')[0] ?? '').replace(
          /\$\{([A-Za-z_$][\w$]*)\}/g,
          (_s, name: string) => {
            const v = consts.get(name);
            if (v === undefined) {
              ok = false;
              return '';
            }
            return v;
          },
        );
        target = ok ? filled : null;
      } else if (expr.startsWith("'") || expr.startsWith('"')) {
        target = expr.slice(1, -1);
      } else {
        target = consts.get(expr) ?? null;
      }
      out.push({
        file: f.slice(MP.length + 1),
        line,
        api,
        page: target === null ? null : (target.split('?')[0] ?? '').replace(/^\//, ''),
        raw: expr,
      });
    }
  }
  return out;
}

const jumps = scan();
const tabs = tabPages();

describe('跳转 API 必须与目标页是否为 tabBar 匹配（AJ-366）', () => {
  it('扫描到足够多的跳转（否则下面的断言是假绿灯）', () => {
    expect(jumps.length).toBeGreaterThan(8);
  });

  it('tabBar 页登记了（app.json 是可信的）', () => {
    expect(tabs.size).toBeGreaterThan(0);
  });

  it('🔴 未解析的动态路径只允许出现在白名单文件里，且每个文件最多 1 条（多了说明写法变了，本守卫正在失效）', () => {
    const allowed = new Set(DYNAMIC_ALLOWED.map((a) => a.file));
    const unresolved = jumps.filter((j) => j.page === null);
    for (const a of DYNAMIC_ALLOWED) {
      expect(
        unresolved.filter((j) => j.file === a.file).length,
        `${a.file} 的豁免只覆盖 1 条（${a.why}）`,
      ).toBeLessThanOrEqual(1);
    }
    const unknown = unresolved.filter((j) => !allowed.has(j.file));
    expect(
      unknown.map((j) => `${j.file}:${j.line} → ${j.raw}`),
      `解析不出目标页的跳转过多 —— 要么写法变了（@limitation 一 要跟着改），要么正则坏了`,
    ).toHaveLength(0);
  });

  it('🔴 目标是 tabBar 页 → 必须 switchTab（redirectTo / navigateTo 会被宿主拒绝）', () => {
    const bad = jumps.filter((j) => j.page !== null && tabs.has(j.page) && j.api !== 'switchTab');
    expect(
      bad.map((j) => `${j.file}:${j.line}  ${j.api} → ${j.page}`),
      '这些跳转指向 tabBar 页却没用 switchTab —— 宿主会直接拒绝，表现是"点了没反应"',
    ).toEqual([]);
  });

  it('🔴 目标不是 tabBar 页 → 不能用 switchTab（会跳不过去）', () => {
    const bad = jumps.filter((j) => j.page !== null && !tabs.has(j.page) && j.api === 'switchTab');
    expect(
      bad.map((j) => `${j.file}:${j.line}  ${j.api} → ${j.page}`),
      '这些跳转用了 switchTab 但目标不是 tabBar 页',
    ).toEqual([]);
  });
});
