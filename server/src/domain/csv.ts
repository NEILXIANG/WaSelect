/**
 * 职责：二维表 → CSV 文本（剩余清单 3-3：订单 / 待采购 / 待发货报关三类导出）。纯函数，无依赖。
 *
 * @why 自己写不引库：规则只有三条（RFC 4180 转义、CRLF、公式注入防护），引一个 CSV 库换不来什么。
 * @why 开头带 UTF-8 BOM：Excel（Windows / 日文版）打开无 BOM 的 UTF-8 CSV 会按本地编码解析，日文品名、中文表头全成乱码；
 *      运营与报关代理都是用 Excel 打开。
 * @why 公式注入防护（OWASP "CSV Injection"）：收件人姓名、地址是买家填的，`=HYPERLINK(...)` 一类内容
 *      在 Excel 里会被当公式执行。以 = + - @ \t \r 开头的**字符串**前加 `'`，Excel 按文本显示。
 * @tradeoff 防护会改动"真的以 - 开头"的文本（如地址 "-12 Main St" 显示成 "'-12 Main St"）——
 *           宁可多一个引号，也不让买家输入在运营电脑上执行。数字类型与号码形态的文本（电话）不受影响。
 * @limitation 不做流式：整表在内存里拼。MVP 量级（日百单）无压力；上万行再改。
 */
export const CSV_BOM = '﻿';

export type CsvCell = string | number | null | undefined | CsvText;

const FORMULA_LEAD = /^[=+\-@\t\r]/;
/**
 * 号码形态（E.164 电话、带空格括号的电话、负数文本）：只含数字、空格、括号、点、连字符，前面最多一个 + / -。
 * @why 演练实测（2026-10-06）：报关清单电话 `+14155550120` 被导出成 `'+14155550120`，报关代理拿到的是错号码。
 *      这种形态里没有函数名、没有单元格引用，Excel 至多把它当数字或算术，不会执行任何东西。
 * @limitation `+1-1` 这类纯算术会被 Excel 当公式算成 0：无执行风险，但显示值会变；真实数据里不会出现这种电话。
 */
const NUMBER_LIKE = /^[+-]?[\d\s().-]+$/;

/**
 * 必须在 Excel 里**保持文本**的号码列（第三轮缺口 P1-8，AJ-386）：邮编、电话、HS 码、运单号、JAN 码。
 * @why Excel 打开 CSV 会把纯号码当数字：邮编 `02134` → `2134`、电话丢 `+`、HS 码 `6912.00` → `6912`、
 *      长运单号变科学计数——报关代理拿到的就是错单。号码形态的值输出成 `="…"`，三大表格软件都按文本显示。
 * @why 只对 NUMBER_LIKE 生效：含字母的值（`EE123456789JP`）本来就是文本；公式形态的值仍走注入防护加 `'`，
 *      `="…"` 里只可能出现数字、空格、括号、点、连字符、加号，不会成为注入面。
 * @limitation 用别的程序（脚本、数据库导入）读这份 CSV 时会看到字面的 `="02134"`——导出的受众是人和表格软件。
 */
export interface CsvText {
  readonly kind: 'text';
  readonly value: string | null | undefined;
}

export function asText(value: string | null | undefined): CsvText {
  return { kind: 'text', value };
}

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const t = v.value;
    if (t === null || t === undefined || t === '') return '';
    return NUMBER_LIKE.test(t) ? `"=""${t}"""` : cell(t);
  }
  const safe = FORMULA_LEAD.test(v) && !NUMBER_LIKE.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return CSV_BOM + [header, ...rows].map((r) => r.map(cell).join(',') + '\r\n').join('');
}
