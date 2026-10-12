/**
 * 报关品名禁词与 HS 编码形状（服务端与管理端同一份，规律排查 2026-10-12）。
 * @why 原先两份规则：服务端按整词比（`\bspf\b`），管理端按子串比——"SPF50+ sunscreen milk" 管理端拦、
 *      服务端放；"Drugstore pouch" 管理端拦、服务端放。HS 编码形状只有管理端判，服务端照收 "HS3304"。
 */
import { describe, expect, it } from 'vitest';
import { customsDescBlockedHits, hsCodeShapeOk } from './customs.js';

describe('customsDescBlockedHits（词首匹配，大小写不敏感）', () => {
  it.each([
    ['UV milk SPF50+ PA++++', ['spf']],
    ['Sunscreens for face', ['sunscreen']],
    ['OTC drugs', ['drug']],
    ['Medicated hand cream', ['medicated']],
    ['Whitening essence', ['whitening']],
    // 词首匹配的代价：drugstore 也命中（报关品名里写药妆店的情形极少；宁可让运营换个写法）
    ['Drugstore pouch', ['drug']],
  ] as const)('🔴 %s → %j', (desc, hits) => {
    expect(customsDescBlockedHits(desc)).toEqual(hits);
  });

  it.each(['Kitchen knife, stainless', 'Green tea powder 40g', 'Face lotion 200ml'])(
    '正常品名不误伤：%s',
    (desc) => {
      expect(customsDescBlockedHits(desc)).toEqual([]);
    },
  );
});

describe('hsCodeShapeOk', () => {
  it.each(['330499', '3304.99', '3304.99.5000', '6912.00', '3304995000'])('合法：%s', (v) => {
    expect(hsCodeShapeOk(v)).toBe(true);
  });
  it.each(['HS3304', '3304,99', '33049', '33049950001', '3304..99', ''])('🔴 不合法：%s', (v) => {
    expect(hsCodeShapeOk(v)).toBe(false);
  });
});
