/**
 * 职责：`jan-code.ts` 的形状、校验位、归一（两端输入测试 2026-10-12）。
 * @why 校验位的判例用真实 JAN（キッコーマン 4901515…、六花亭 4909990017899）与 GS1 文档的 EAN-8 例子，
 *      不拿自己算出来的数当"正确答案"——那会和实现一起错。
 */
import { describe, expect, it } from 'vitest';
import { janCheckDigitOk, janShapeOk, normalizeJan } from './jan-code.js';

describe('janShapeOk', () => {
  it.each([
    ['4909990017899', true],
    ['49123456', true],
    ['490999001789', false], // 12 位（UPC）不收
    ['1234567', false],
    ['49099900178990', false],
    ['4909990O17899', false], // 字母 O 冒充 0
    ['', false],
  ])('%j → %s', (v, want) => {
    expect(janShapeOk(v)).toBe(want);
  });
});

describe('janCheckDigitOk', () => {
  it.each([
    ['4909990017899', true],
    ['4901872071234', true],
    ['96385074', true], // GS1 EAN-8 示例
    ['4909990017898', false],
    ['96385075', false],
    ['abc', false],
  ])('%j → %s', (v, want) => {
    expect(janCheckDigitOk(v)).toBe(want);
  });
});

describe('normalizeJan', () => {
  it('全角转半角、去空格与横线；其它字符原样留给形状判断', () => {
    expect(normalizeJan('４９０９ ９９０-０１７８９９')).toBe('4909990017899');
    expect(normalizeJan('49O9990017899')).toBe('49O9990017899');
  });
});
