/** 职责：CSV 编码（剩余清单 3-3）——RFC 4180 转义、公式注入防护、Excel 中文不乱码。 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, toCsv } from './csv.js';

describe('toCsv', () => {
  it('🔴 逗号 / 引号 / 换行按 RFC 4180 包引号、引号加倍；行尾 CRLF；首行表头', () => {
    const out = toCsv(['名', '备注'], [['包丁, 165mm', 'say "hi"\nok']]);
    expect(out).toBe(`${CSV_BOM}名,备注\r\n"包丁, 165mm","say ""hi""\nok"\r\n`);
  });

  it('null / undefined → 空格子；数字原样', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, 12800]])).toBe(
      `${CSV_BOM}a,b,c\r\n,,12800\r\n`,
    );
  });

  it('🔴 公式注入：以 = + - @ 制表符 回车 开头的字符串前加单引号（OWASP CSV Injection）', () => {
    const out = toCsv(
      ['x'],
      [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@SUM(A1)'], ['\tx']],
    );
    expect(out.split('\r\n').slice(1, 6)).toEqual([
      `"'=HYPERLINK(""http://evil"")"`,
      "'+1",
      "'-2",
      "'@SUM(A1)",
      "'\tx",
    ]);
  });

  it('负数**数字**不加引号前缀（防护只针对字符串）', () => {
    expect(toCsv(['n'], [[-5]])).toBe(`${CSV_BOM}n\r\n-5\r\n`);
  });
});
