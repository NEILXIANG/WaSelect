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

  it('🔴 公式注入：以 = + - @ 制表符 回车 开头的字符串前加单引号（OWASP CSV Injection）；纯数字形态的 + / - 除外', () => {
    const out = toCsv(
      ['x'],
      [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@SUM(A1)'], ['\tx']],
    );
    expect(out.split('\r\n').slice(1, 6)).toEqual([
      `"'=HYPERLINK(""http://evil"")"`,
      '+1',
      '-2',
      "'@SUM(A1)",
      "'\tx",
    ]);
  });

  it('负数**数字**不加引号前缀（防护只针对字符串）', () => {
    expect(toCsv(['n'], [[-5]])).toBe(`${CSV_BOM}n\r\n-5\r\n`);
  });
});

/**
 * 演练实测（2026-10-06）：报关清单的电话 `+14155550120` 被导出成 `'+14155550120`——
 * 防注入把 E.164 电话当成了公式。纯号码 / 纯数字形态的文本不可能被 Excel 当公式执行，不该加引号。
 */
describe('toCsv：号码形态不加引号', () => {
  it('🔴 E.164 电话、负数文本、带空格括号的电话 → 原样；真公式仍加引号', () => {
    const lines = toCsv(
      ['x'],
      [['+14155550120'], ['-12.5'], ['+1 (415) 555-0120'], ['=1+1'], ['+SUM(A1)'], ['-2+3*cmd']],
    )
      .split('\r\n')
      .slice(1, 7);
    expect(lines).toEqual([
      '+14155550120',
      '-12.5',
      '+1 (415) 555-0120',
      "'=1+1",
      "'+SUM(A1)",
      "'-2+3*cmd",
    ]);
  });
});
