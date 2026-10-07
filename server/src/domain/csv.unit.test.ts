/** 职责：CSV 编码（剩余清单 3-3）——RFC 4180 转义、公式注入防护、Excel 中文不乱码。 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, asText, toCsv } from './csv.js';

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

/**
 * 第三轮缺口 P1-8（AJ-386）：Excel 打开 CSV 时把号码列当数字——邮编 `02134` 变 `2134`、电话 `+1415…` 丢 `+`、
 * HS 码 `6912.00` 变 `6912`、长运单号变科学计数。报关代理拿到的就是错单。
 * `asText` 标记的列输出成 `="…"`（Excel / Numbers / Google Sheets 都按文本显示），且只对号码形态生效。
 */
describe('toCsv：asText 列在 Excel 里保持文本', () => {
  it('🔴 号码形态 → ="…"（CSV 转义后两侧引号加倍）；空值仍为空', () => {
    const lines = toCsv(
      ['zip', 'phone', 'hs'],
      [
        [asText('02134'), asText('+14155550120'), asText('6912.00')],
        [asText(null), asText(''), asText(undefined)],
      ],
    )
      .split('\r\n')
      .slice(1, 3);
    expect(lines).toEqual(['"=""02134""","=""+14155550120""","=""6912.00"""', ',,']);
  });

  it('🔴 非号码形态（含字母 / 公式）不包 ="…"，仍走公式注入防护', () => {
    const lines = toCsv(['x'], [[asText('EE123456789JP')], [asText('=HYPERLINK("x")')]])
      .split('\r\n')
      .slice(1, 3);
    expect(lines).toEqual(['EE123456789JP', `"'=HYPERLINK(""x"")"`]);
  });
});
