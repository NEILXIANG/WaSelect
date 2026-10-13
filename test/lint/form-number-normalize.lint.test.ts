/**
 * 职责：把「后台文本框里手填的数字，解析前必须归一（全角→半角）」从约定变成**会红的检查**。
 *
 * @why 同一类漏网在这个项目里出现了**三次**：
 *      ① 2593097 修了"批量发货确认的单数 / 列表改库存 / Banner 排序 / 分类排序"；
 *      ② 三天提交复查补了运费分档（`ops/view.ts` 的 `parseCount`，注释里写着"2593097 修了排序 / 库存，运费表漏了"）；
 *      ③ 本轮扫描发现**汇率**（`fxFormErrors` / `fxPreview` / `toFxBody`）一直没归一——
 *         汇率的框是普通文本框（`FxPanel.tsx` 的 `<input className="input">`，没有 `type="number"`），
 *         中文输入法全角模式打出的 `０.００６７` 能原样进来，`Number()` 判成 `NaN`，
 *         运营看到的是"原始汇率必须是大于 0 的数字"，而他确实填了数字。
 *      三次都发生在同一个文件 `admin-web/src/ops/view.ts`（前两次是运费档与排序的邻座），
 *      所以这条门禁就守这个文件：它是"同一件事两处各写一份、改一份漏一份"（规律②）的高发地。
 *
 * @limitation 一：这是**文本扫描**不是 AST，而且**只扫 `admin-web/src/ops/view.ts`**。
 *              别的页面（`products/view.ts` 等）没被覆盖是有意的：那些字段用的是 `<input type="number">`，
 *              浏览器自己会拦住全角字符（值被清空、根本到不了解析函数），
 *              把它们一起纳入只会逼出一串豁免注释，反而让人不再看门禁的结论。
 *              → 代价：**别的页面若出现文本框数字（非 type=number），本门禁不会红**，
 *              那一类仍靠人工核对（"这个框是文本框还是数字框"）。
 *              要覆盖全仓，需要先立一条约定（所有表单数字解析必须走一个 shared 助手），
 *              那时的扫描才可能是准的——现在写会误伤"服务端数据"的 `Number(row['x'])`。
 * @limitation 二：判据是"命中 `Number(f[` / `Number(a[` 的行里同时出现归一助手"，
 *              换个写法（先把值赋给中间变量、另一行再 Number）会漏过。漏过是"少一次保护"，
 *              误红是"多看一眼"，所以判据宁窄勿宽。
 * @limitation 三：豁免注释只要求"存在"，不审理由是否成立（同其它注释门禁）；
 *              识别窗口是"本行往前两行内"，写得太远（≥3 行）会误红——误红只是多看一眼，比漏检便宜。
 *
 * @see docs/规律总结与全仓排查-2026-10-12.md §3 规律④⑥；admin-web/src/ops/view.ts（rawRateNumber / parseCount）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
/** 本门禁守的文件（理由见文件头 @limitation 一）。 */
const TARGET = 'admin-web/src/ops/view.ts';
/** 归一助手：解析文本框里的数字必须经由其中之一（顺序无关，同一行出现即可）。 */
const NORMALIZERS = ['rawRateNumber(', 'parseCount(', 'halfWidth('];
/** 豁免注释（确实不需要归一的行，例如值来自服务端响应而不是用户输入）。 */
const EXEMPT = 'form-number-normalize-ok:';

describe('后台表单数字解析必须归一（全角→半角）', () => {
  it(`🔴 ${TARGET} 里每个 Number(f[…]) / Number(a[…]) 都经由归一助手或有豁免注释`, () => {
    const lines = readFileSync(resolve(root, TARGET), 'utf8').split('\n');
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释行不算（本文件里注释引用了旧写法）
      if (!/Number\(\s*[a-zA-Z_$]+\[/.test(line)) return;
      if (NORMALIZERS.some((n) => line.includes(n))) return;
      // 豁免：本行、或 **本行往前两行内**（一组解析共用一条理由注释时更好读；同 idempotency-request 门禁的"窗口"做法）
      if ([line, lines[i - 1] ?? '', lines[i - 2] ?? ''].some((l) => l.includes(EXEMPT))) return;
      offenders.push(`${TARGET}:${String(i + 1)} ${line.trim()}`);
    });
    expect(
      offenders,
      '文本框里的数字（中文输入法会给全角）必须先经 rawRateNumber / parseCount / halfWidth 归一；' +
        '值确实来自服务端响应（不是用户输入）时，在该行写 `// form-number-normalize-ok: <理由>`',
    ).toEqual([]);
  });

  /**
   * 上面那条只看**调用点**：把助手里面的 `halfWidth` 删掉，调用点照样合规（注入验证实测：漏过）。
   * 所以助手自身的实现也要钉住——本条与上一条合起来才是"归一真的发生了"。
   */
  it('🔴 归一助手自身的实现里必须有 halfWidth（否则调用点合规但根本没归一）', () => {
    const lines = readFileSync(resolve(root, TARGET), 'utf8').split('\n');
    const missing: string[] = [];
    lines.forEach((line, i) => {
      const m = /^function (\w+)\(/.exec(line.trim());
      if (m === null) return;
      const name = m[1] ?? '';
      if (!NORMALIZERS.some((n) => n === `${name}(`)) return;
      // 函数体窗口：本行起 20 行（本文件里的两个助手都不到 10 行）
      const body = lines.slice(i, i + 20).join('\n');
      if (!body.includes('halfWidth(')) missing.push(`${name}（${TARGET}:${String(i + 1)}）`);
    });
    expect(
      missing,
      '这些助手号称"归一"，实现里却看不到 halfWidth：要么补上，要么把调用点改成别的归一助手',
    ).toEqual([]);
  });
});
