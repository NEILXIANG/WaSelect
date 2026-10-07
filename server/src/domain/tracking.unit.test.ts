/** 职责：查件链接（剩余清单 3-5）。 */
import { describe, expect, it } from 'vitest';
import { trackingUrl } from './tracking.js';
import { trackingNoRecognized } from './tracking.js';

const JP = (n: string) =>
  `https://trackings.post.japanpost.jp/services/srv/search?requestNo1=${n}&search.x=1&search.y=1&locale=en&startingUrlPatten=`;

describe('trackingUrl', () => {
  it('🔴 日本邮便国际单号（UPU S10：2 字母 + 9 数字 + JP）→ 官方英文追踪页，与承运商写法无关', () => {
    expect(trackingUrl('EMS', 'EE123456789JP')).toBe(JP('EE123456789JP'));
    expect(trackingUrl('ems', 'LX123456789JP')).toBe(JP('LX123456789JP'));
    expect(trackingUrl('随便写的', 'RR123456789JP')).toBe(JP('RR123456789JP'));
  });

  it('单号带空格 / 小写 → 归一后再判', () => {
    expect(trackingUrl('EMS', ' ee 123 456 789 jp ')).toBe(JP('EE123456789JP'));
  });

  it('承运商明确是日本邮便（EMS / ePacket / Japan Post / 日本郵便 / JPPOST）但单号不是 S10 → 仍给日本邮便链接', () => {
    expect(trackingUrl('Japan Post', '123456789012')).toBe(JP('123456789012'));
    expect(trackingUrl('日本郵便', '123456789012')).toBe(JP('123456789012'));
    expect(trackingUrl('ePacket', 'X1')).toBe(JP('X1'));
  });

  /** 扫描 A-04：`includes('ems')` 把 "Yamato Transport Systems" 也当成日本邮便。 */
  it('🔴 承运商名只按整词匹配：名字里碰巧含 ems 的不算日本邮便', () => {
    expect(trackingUrl('Yamato Transport Systems', '1234-5678-9012')).toBeNull();
    expect(trackingUrl('EMS (Japan Post)', '123456789012')).not.toBeNull();
  });

  it('认不出的承运商 + 非日本邮便单号 → null（不猜链接：给错链接比不给更糟）', () => {
    expect(trackingUrl('yamato', '1234-5678-9012')).toBeNull();
    expect(trackingUrl(null, 'EE123456789US')).toBeNull();
  });

  it('单号为空 → null；单号里的特殊字符被 URL 编码（不能拼出别的参数）', () => {
    expect(trackingUrl('EMS', null)).toBeNull();
    expect(trackingUrl('EMS', '   ')).toBeNull();
    expect(trackingUrl('EMS', 'A&locale=ja')).toBe(JP('A%26LOCALE%3DJA'));
  });
});

describe('trackingNoRecognized（第三轮缺口 P1-10：发货 / 改单号时提示核对，不拦）', () => {
  it.each([
    ['EMS', 'EE123456789JP', true],
    ['ems', 'ee 123456789 jp', true],
    ['EMS', 'EE12345678JP', false],
    ['EMS', '=HYPERLINK("x")', false],
    ['Yamato', '1234-5678-9012', true],
    ['Yamato', '12', false],
    ['', '', false],
  ] as const)('%s / %s → %s', (carrier, no, expected) => {
    expect(trackingNoRecognized(carrier, no)).toBe(expected);
  });
});
