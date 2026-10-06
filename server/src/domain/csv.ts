/**
 * 职责：二维表 → CSV 文本（剩余清单 3-3：订单 / 待采购 / 待发货报关三类导出）。纯函数，无依赖。
 *
 * @why 自己写不引库：规则只有三条（RFC 4180 转义、CRLF、公式注入防护），引一个 CSV 库换不来什么。
 * @why 开头带 UTF-8 BOM：Excel（Windows / 日文版）打开无 BOM 的 UTF-8 CSV 会按本地编码解析，日文品名、中文表头全成乱码；
 *      运营与报关代理都是用 Excel 打开。
 * @why 公式注入防护（OWASP "CSV Injection"）：收件人姓名、地址是买家填的，`=HYPERLINK(...)` 一类内容
 *      在 Excel 里会被当公式执行。以 = + - @ \t \r 开头的**字符串**前加 `'`，Excel 按文本显示。
 * @tradeoff 防护会改动"真的以 - 开头"的文本（如地址 "-12 Main St" 显示成 "'-12 Main St"）——
 *           宁可多一个引号，也不让买家输入在运营电脑上执行。数字类型不受影响。
 * @limitation 不做流式：整表在内存里拼。MVP 量级（日百单）无压力；上万行再改。
 */
export const CSV_BOM = '﻿';

export type CsvCell = string | number | null | undefined;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const safe = FORMULA_LEAD.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return CSV_BOM + [header, ...rows].map((r) => r.map(cell).join(',') + '\r\n').join('');
}
