/**
 * 职责：把「'进行中的售后' 只有 shared 一份真源」从约定变成**会红的检查**。
 *
 * @why 这条规则（`open` / `processing` 两个状态）在服务端决定三件事：
 *      「能不能再提售后申请」（`after-sale-routes.ts` 撞部分唯一索引 → 40902 `after_sale_open`）、
 *      「能不能撤销发货」（`revertShipmentGuard`）、「超时未发货 / 待办要不要算进来」。
 *      本轮规律排查（规律②）在它上面数出**四处副本**：
 *      ① `packages/shared/src/after-sale.ts` 的 `AFTER_SALE_OPEN_STATUSES`（真源）；
 *      ② `admin-web/src/orders/fix-view.ts` 手写 `['open', 'processing']`（撤销发货的门槛）；
 *      ③ `admin-web/src/orders/after-sale-view.ts` 手写 `a.status === 'open' || a.status === 'processing'`
 *         （**连写法都不同**，所以按数组扫的脚本也数不出它）；
 *      ④ `miniprogram/utils/after-sale.js` 的局部量 `OPEN`（没名字没注释，因此 `after-sale.unit.test.ts`
 *         那组"逐项与 shared 比对"的镜像检查**漏掉了它**——名字对不上就没人想到要比）。
 *      其中 ②③ 在 admin-web，而 admin-web **本来就能 import shared**（同文件已经在 import 别的常量），
 *      属于"多写一份而不是引用"；漂移的后果是运营点「撤销发货」→ 服务端 40902 → 前端说
 *      "状态刚变了，请刷新"，而状态根本没变，重试永远不会成功。
 *
 * @limitation 一：这是**文本扫描**不是 AST，判据是"同一行里同时出现 `'open'` 与 `'processing'` 两个字面量"。
 *              换行分开写、或写成别的等价形式（`Set`、映射表）会漏过。漏过是"少一次保护"，
 *              误红是"多看一眼"，所以判据宁窄勿宽。
 * @limitation 二：只扫 `admin-web/src` 与 `miniprogram`，**不扫 `packages/shared`**——
 *              那是真源，它本来就应该写出这两个字面量。
 * @limitation 三：小程序侧给它留了一个**白名单文件**（不能 import shared：没有构建步骤）。
 *              也就是说这里放行的不是"某一行"，而是"那个文件里的这一份具名镜像"——
 *              白名单之外的任何地方再出现这个状态对都会红。
 * @limitation 四：豁免注释只要求"存在"，不审理由是否成立（同其它注释门禁）。
 *
 * @see packages/shared/src/after-sale.ts（AFTER_SALE_OPEN_STATUSES）；
 *      miniprogram/utils/after-sale.js（小程序镜像）；docs/规律总结与全仓排查-2026-10-12.md §3 规律②
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
/** 小程序侧唯一允许手写这个状态对的文件（无构建步骤，不能 import shared，只能做具名镜像）。 */
const MIRROR_FILE = 'miniprogram/utils/after-sale.js';
/** 状态对的两个成员（本文件必须写出它们——否则这条门禁自己就没法找它们了）。 */
const PAIR = ["'open'", "'processing'"];
/** 豁免注释（确实要在别处手写这个状态对时用）。 */
const EXEMPT = 'after-sale-open-mirror-ok:';
/** 扫描根（相对仓库根）。 */
const ROOTS = ['admin-web/src', 'miniprogram'];
/** 不扫的目录：宿主产物与依赖。 */
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', 'dist']);

/**
 * 去掉 `//` 行注释与 `/* … *\/` 块注释，**保留换行**（行号因此不变）。
 * @why 本仓库大量在注释里引用这些值（"原先这里手写 ['open','processing']"），不剥注释会一片误红。
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
      inLine = true; // ⚠️ 只丢本行，不是整个文件（写成 break 会把文件截断，门禁因此漏检）
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

/** 列出扫描根下所有源码文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|js)$/.test(name)) continue;
    if (name.includes('.test.')) continue; // 测试自己会写这两个值（断言镜像），不是待扫的源码
    out.push(full);
  }
  return out;
}

describe('「进行中的售后」状态对只能来自 shared（或其具名镜像）', () => {
  it(`🔴 admin-web / 小程序里不再手写 ${PAIR.join(' + ')}`, () => {
    const offenders: string[] = [];
    for (const base of ROOTS) {
      for (const file of sourceFiles(resolve(root, base))) {
        const rel = relative(root, file);
        if (rel === MIRROR_FILE) continue;
        const lines = stripComments(readFileSync(file, 'utf8'));
        lines.forEach((line, i) => {
          if (!PAIR.every((p) => line.includes(p))) return;
          // 豁免：本行、或本行往前两行内（同 idempotency-request 门禁的"窗口"做法）
          if ([line, lines[i - 1] ?? '', lines[i - 2] ?? ''].some((l) => l.includes(EXEMPT)))
            return;
          offenders.push(`${rel}:${String(i + 1)} ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      `这处手写了"进行中的售后"（open / processing）。改成引用 shared 的 AFTER_SALE_OPEN_STATUSES` +
        `（admin-web 能直接 import；小程序见 ${MIRROR_FILE} 的具名镜像）；` +
        `确实要在别处手写时，写 \`// ${EXEMPT} <理由>\``,
    ).toEqual([]);
  });

  it('🔴 小程序那份镜像确实存在且名字与 shared 对得上（不是被顺手删了）', () => {
    const src = readFileSync(resolve(root, MIRROR_FILE), 'utf8');
    // 名字必须与 shared 一致：名字对不上就没人会想到去比对（本周刚踩过的那个坑）
    expect(src).toContain('export const AFTER_SALE_OPEN_STATUSES');
    expect(PAIR.every((p) => src.includes(p))).toBe(true);
  });
});
