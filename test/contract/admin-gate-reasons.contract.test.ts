/**
 * 职责：钉住「契约里逐条列出的 `data.reason` 清单，与实现真正会返回的**完全一致**」（双向）。
 *
 * @why 0.6.91 那次订正是这条门禁的由来：`POST /admin/orders/{id}/shipment/revert` 的描述早就写着
 *      `409 / 40902 data.reason = status_<状态> / revert_window_passed / after_sale_open`，
 *      而实现（`domain/admin-order-actions.ts::revertShipmentGuard`）还会在"状态是 shipped 但
 *      `shipped_at` 为空"这条脏数据路径上返回 `shipped_at_missing`——**契约漏列**。
 *      这一类漂移没有信号：不报错、测试全绿，只是"读契约的人以为这条分支不存在"，
 *      而写契约的人以为自己在描述现状（与 AJ-519 里"契约承诺了、实现没兑现"是同一枚硬币的两面）。
 *      所以这里把"描述里的 reason 清单"当**承诺**来验，两个方向都验。
 *
 * @why 只登记**描述里是逐条枚举**的端点：本仓大多数端点的 description 是叙述式（"有在途的部分退款 →
 *      `40902 partial_refund_in_flight`"），并没有声称"这就是全部"。对那种描述做这个检查是比错了东西——
 *      它没承诺穷举，缺项不算漂移。要登记新端点，先把它的描述改写成显式清单（那是一次契约变更，不是加检查）。
 *
 * @limitation 一：只认 `deny(40902, 'x')` 与 `reason: 'x'` 两种字面形状（守卫体里就是这个写法）。
 *              经变量转手（`const r = 'x'; deny(40902, r)`）判不出来——属漏保不是误红。
 *              模板串（`` `status_${i.status}` ``）不参与"实现→契约"方向，只参与"契约→实现"方向
 *              （契约里写的是 `status_<状态>`，按前缀匹配）。
 * @limitation 二：函数体是按**大括号配对**从源码里切的（与 `test/lint/*` 同套路），不是 AST。
 *              守卫被拆成多个函数、或把拒绝集中到一个 `deny` 工厂里，这里就切不到了——
 *              那时必须重新设计这条检查，而不是继续加白名单。
 * @limitation 三：只管契约与实现这一对，不管前端读不读得到（那是 `test/lint/error-reason-public` 的职责）。
 *
 * @see contracts/api-contract.yaml（revert 端点描述）；server/src/domain/admin-order-actions.ts；
 *      docs/自主决策记录.md AJ-521
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const CONTRACT = 'contracts/api-contract.yaml';

interface Entry {
  /** 契约里的路径键（取它下面那条 `description:`）。 */
  path: string;
  /** 实现所在的文件（相对仓库根）。 */
  file: string;
  /** 守卫函数名（按大括号配对取函数体）。 */
  fn: string;
  /** 该守卫里**对外**的原因挂在哪个码上（只有它会进 `data.reason`）。 */
  code: number;
}

const ENTRIES: Entry[] = [
  {
    path: '/admin/orders/{id}/shipment/revert',
    file: 'server/src/domain/admin-order-actions.ts',
    fn: 'revertShipmentGuard',
    code: 40902,
  },
];

/** 取路径键下面第一条单引号描述（与 router 的键同级缩进）。 */
function descriptionOf(yaml: string, path: string): string {
  const at = yaml.indexOf(`\n  ${path}:`);
  if (at < 0) throw new Error(`契约里找不到路径键 ${path}（路径改名了？那要同步改本文件）`);
  const seg = yaml.slice(at, at + 8000);
  const key = seg.indexOf("\n      description: '");
  if (key < 0) throw new Error(`${path} 的描述不是单引号块（改写形状了？本检查按单引号取）`);
  const from = key + '\n      description: '.length;
  const to = seg.indexOf("'\n", from);
  if (to < 0) throw new Error(`${path} 的描述没有结束引号`);
  return seg.slice(from, to);
}

/**
 * 按大括号配对取函数体（含签名）。
 *
 * @why 从**参数表的 `)` 之后**找第一个 `{`，而不是从函数名之后找：本仓的守卫都长这样——
 *      `export function revertShipmentGuard(i: {\n status: …\n}): AdminGateResult {`，
 *      参数是**多行对象类型字面量**。从函数名之后找 `{` 会切到参数类型那一对里，
 *      切出来的"函数体"一个 `deny(` 都没有，于是两条断言**双双变成假绿灯**
 *      （本文件第一版就是这样：正向检查因为"实现里没解析到原因"而红，反向检查因为"实现什么都不返回"
 *      把三条全判成"契约承诺了不存在的行为"）。这个形态已进下面的自检。
 */
function functionBody(src: string, fn: string): string {
  const decl = new RegExp(`(?:export\\s+)?function\\s+${fn}\\s*\\(`).exec(src);
  if (decl === null) throw new Error(`源码里找不到函数 ${fn}（改名了？那要同步改本文件）`);
  // 1) 参数表的右括号
  const open = src.indexOf('(', decl.index);
  let depth = 0;
  let closeParen = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) throw new Error(`${fn} 的括号没有闭合`);
  // 2) 参数表之后第一个 `{` 才是函数体（前面可能还有返回类型标注）
  const bodyOpen = src.indexOf('{', closeParen);
  if (bodyOpen < 0) throw new Error(`${fn} 没有函数体（是箭头函数？本检查只认 function 声明）`);
  let braces = 0;
  for (let i = bodyOpen; i < src.length; i += 1) {
    if (src[i] === '{') braces += 1;
    else if (src[i] === '}') {
      braces -= 1;
      if (braces === 0) return src.slice(decl.index, i + 1);
    }
  }
  throw new Error(`${fn} 的函数体括号没有闭合`);
}

/** 函数体里挂在 `code` 码上的原因字面量。模板串（`` `status_${x}` ``）记成前缀 `status_`。 */
function reasonsInBody(body: string, code: number): string[] {
  const out = new Set<string>();
  // 单引号字面量
  for (const m of body.matchAll(new RegExp(`deny\\(\\s*${code}\\s*,\\s*'([a-z_]+)'`, 'g')))
    out.add(m[1] ?? '');
  for (const m of body.matchAll(new RegExp(`code:\\s*${code}\\s*,\\s*reason:\\s*'([a-z_]+)'`, 'g')))
    out.add(m[1] ?? '');
  // 模板串：`status_${x}` 这类拼出来的值，取 `${` 前的字面前缀（契约里写作 status_<状态>）。
  // ⚠️ 反引号在下面写作 \u0060、`${` 写作 \$ + \{：正则串本身在模板字面量里，
  //    直接嵌反引号或 `${` 会把模板提前闭合（本文件第一次写就是这样崩的）。
  for (const m of body.matchAll(
    new RegExp(`deny\\(\\s*${code}\\s*,\\s*\\u0060([a-zA-Z_]+)\\$\\{`, 'g'),
  ))
    out.add(m[1] ?? '');
  for (const m of body.matchAll(
    new RegExp(`code:\\s*${code}\\s*,\\s*reason:\\s*\\u0060([a-zA-Z_]+)\\$\\{`, 'g'),
  ))
    out.add(m[1] ?? '');
  return [...out].filter((r) => r !== '');
}

/**
 * 描述里 `data.reason = A / B / C` 列出的清单（`status_<状态>` 归一成前缀 `status_`）。
 * @why 每个 token 再截掉紧跟的散文（`，…` / `（…`）：契约里常在清单后就地补一句订正说明
 *      （"0.6.91：补列最后一条…"），那是描述、不是清单的一部分。截断只影响尾随文字，
 *      不会把真正的清单项吃掉（清单项本身不含逗号与括号）。
 */
function listedInDescription(desc: string): string[] {
  const m = /data\.reason\s*=\s*([^；;）)]+)/.exec(desc);
  if (m === null) throw new Error('描述里没有 `data.reason = …` 清单（改写形状了？）');
  return (m[1] ?? '')
    .split('/')
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .map((s) => s.replace(/[，,（(].*$/u, '').trim())
    .filter((s) => s !== '')
    .map((s) => (s.includes('<状态>') ? 'status_' : s));
}

/** 前缀（`status_`）或整词出现在描述里。 */
function inDescription(desc: string, reason: string): boolean {
  return reason.endsWith('_') ? desc.includes(reason) : new RegExp(`\\b${reason}\\b`).test(desc);
}

describe('契约里逐条列出的 data.reason 清单必须与实现一致（双向）', () => {
  it('扫描对象存在且取到了内容（否则下面两条是假绿灯）', () => {
    const yaml = readFileSync(resolve(root, CONTRACT), 'utf8');
    expect(ENTRIES.length).toBeGreaterThan(0);
    for (const e of ENTRIES) {
      expect(descriptionOf(yaml, e.path), `${e.path} 的描述为空`).not.toBe('');
      const body = functionBody(readFileSync(resolve(root, e.file), 'utf8'), e.fn);
      expect(reasonsInBody(body, e.code).length, `${e.fn} 里没解析到任何原因`).toBeGreaterThan(0);
    }
  });

  it('🔴 实现会返回的每个原因都列在契约里（漏列 = 读契约的人以为这条分支不存在）', () => {
    const yaml = readFileSync(resolve(root, CONTRACT), 'utf8');
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const desc = descriptionOf(yaml, e.path);
      const body = functionBody(readFileSync(resolve(root, e.file), 'utf8'), e.fn);
      for (const reason of reasonsInBody(body, e.code)) {
        if (!inDescription(desc, reason))
          bad.push(
            `${e.file}::${e.fn} 会返回 ${e.code} 的 \`${reason}\`，但 ${e.path} 的描述里没列它`,
          );
      }
    }
    expect(bad, `契约漏列实现会返回的原因：\n${bad.join('\n')}`).toEqual([]);
  });

  it('🔴 契约里列出的每个原因都真的会返回（列了不返 = 承诺不存在的行为）', () => {
    const yaml = readFileSync(resolve(root, CONTRACT), 'utf8');
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const desc = descriptionOf(yaml, e.path);
      const body = functionBody(readFileSync(resolve(root, e.file), 'utf8'), e.fn);
      const actual = reasonsInBody(body, e.code);
      for (const reason of listedInDescription(desc)) {
        if (!actual.some((a) => (reason.endsWith('_') ? a.startsWith(reason) : a === reason)))
          bad.push(`${e.path} 的描述里列了 \`${reason}\`，但 ${e.fn} 不会返回它`);
      }
    }
    expect(bad, `契约承诺了实现不会返回的原因：\n${bad.join('\n')}`).toEqual([]);
  });

  it('匹配器自检：漏列能扫出来、真实形状不被误报', () => {
    const body = [
      'export function guard(i: I): R {',
      "  if (i.a) return deny(40902, 'after_sale_open');",
      "  if (i.b === null) return deny(40902, 'shipped_at_missing');",
      '  return i.c < W ? OK : deny(40902, `status_${i.status}`);',
      '}',
    ].join('\n');
    expect(reasonsInBody(body, 40902)).toEqual([
      'after_sale_open',
      'shipped_at_missing',
      'status_',
    ]);
    // 只认 40902：同函数里别的码的原因不算（它们不进这个端点的 data.reason 清单）
    const mixed = "  if (x) return deny(40909, 'dispute_open');";
    expect(reasonsInBody(mixed, 40902)).toEqual([]);
    expect(listedInDescription('…（data.reason = status_<状态> / revert_window_passed）…')).toEqual(
      ['status_', 'revert_window_passed'],
    );
    // 清单后就地补的散文不算清单项（契约里就是这么写的）
    expect(listedInDescription('data.reason = status_<状态> / shipped_at_missing）；后略')).toEqual(
      ['status_', 'shipped_at_missing'],
    );
    expect(inDescription('… / revert_window_passed）', 'revert_window_passed')).toBe(true);
    expect(inDescription('… / revert_window_passed）', 'shipped_at_missing')).toBe(false);
    // 前缀型只认出现，不要求边界（`status_shipped` 才是运行时的值）
    expect(inDescription('data.reason = status_<状态>', 'status_')).toBe(true);
  });

  it('匹配器自检：参数是**多行对象类型**时也要切到函数体，不能切到参数类型里', () => {
    // ⚠️ 这是本文件第一版真踩的坑：本仓的守卫签名都长这样，从函数名后找 `{` 会切到参数类型那一对，
    //    切出来的"函数体"里一个 deny 都没有 —— 正向检查红、反向检查把契约里的三条全判成"不存在"。
    const src = [
      'export function guard(i: {',
      '  a: boolean;',
      '  b: Date | null;',
      '}): Result {',
      "  if (i.a) return deny(40902, 'after_sale_open');",
      '  return deny(40902, `status_${i.b}`);',
      '}',
      'export function other(): void {}',
    ].join('\n');
    const body = functionBody(src, 'guard');
    expect(body).toContain("deny(40902, 'after_sale_open')");
    expect(body).toContain('status_${i.b}');
    expect(body, '切过头了：把下一个函数也包进来').not.toContain('function other');
    expect(reasonsInBody(body, 40902).sort()).toEqual(['after_sale_open', 'status_']);
  });
});
