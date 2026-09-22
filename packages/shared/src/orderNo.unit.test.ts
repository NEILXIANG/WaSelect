/**
 * 职责：订单号格式化的 L0 单测 + 属性测试（round-trip / 定长 / 非法输入）。
 * @see 技术文档 v0.5 §3（orders.order_no VARCHAR(20)）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { encodeSeq, formatOrderNo, parseOrderNoDate } from './orderNo.js';

describe('encodeSeq', () => {
  it('属性：任意非负整数都能编码为定长且可 round-trip 长度', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 32 ** 6 - 1 }), (n) => {
        const s = encodeSeq(n);
        expect(s).toHaveLength(6);
        expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      }),
      { numRuns: 300 },
    );
  });

  it('负数与非整数拒绝', () => {
    expect(() => encodeSeq(-1)).toThrow(RangeError);
    expect(() => encodeSeq(1.5)).toThrow(RangeError);
  });
});

describe('formatOrderNo / parseOrderNoDate', () => {
  it('格式 W+YYYYMMDD-6位，总长 16（DB 上限 20）', () => {
    const no = formatOrderNo('20260922', 1);
    expect(no).toBe('W20260922-000001');
    expect(no.length).toBeLessThanOrEqual(20);
  });

  it('属性：任意合法日期与序号都能解析回原日期', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1970, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 32 ** 6 - 1 }),
        (y, m, d, seq) => {
          const date = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
          const no = formatOrderNo(date, seq);
          expect(parseOrderNoDate(no)).toBe(date);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('非法日期格式拒绝；非法单号返回 undefined', () => {
    expect(() => formatOrderNo('2026-09-22', 1)).toThrow(RangeError);
    expect(parseOrderNoDate('X20260922-000001')).toBeUndefined();
  });
});
