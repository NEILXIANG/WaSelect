/**
 * 职责：TOTP（RFC 6238，SHA-1 / 30 秒 / 6 位）——管理端二次验证（第三轮缺口 P1-5，AJ-386）。
 * @why 用 RFC 6238 附录 B 的官方向量钉算法：自己实现的 HMAC 截断只要错一位，所有验证器 App 都对不上，
 *      而"自己生成、自己校验"的往返用例永远是绿的。
 */
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpAt,
  totpUri,
  verifyTotp,
} from './totp.js';

// RFC 6238 附录 B：SHA-1 的种子是 ASCII "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totpAt（RFC 6238 附录 B，SHA-1，取 8 位向量的后 6 位）', () => {
  it.each([
    [59, '287082'], // 94287082
    [1111111109, '081804'], // 07081804：前导 0 必须保留
    [1111111111, '050471'], // 14050471
    [1234567890, '005924'], // 89005924
    [2000000000, '279037'], // 69279037
    [20000000000, '353130'], // 65353130：步数超出 32 位
  ])('t=%i → %s', (sec, code) => {
    expect(totpAt(RFC_SECRET, sec * 1000)).toBe(code);
  });
});

describe('base32', () => {
  it('RFC 4648 向量：foobar ↔ MZXW6YTBOI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });
  it('解码容忍小写、空格与 = 填充（验证器 App 显示的密钥常带空格分组）', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
  });
  it('非法字符 → 抛错（不静默跳过，否则密钥被悄悄截短）', () => {
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('verifyTotp', () => {
  const now = 1_790_000_000_000;
  it('当前步与前后各一步（±30 秒时钟漂移）通过，返回命中的步数', () => {
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
  });
  it('🔴 超出 ±1 步 / 形状不对 → null', () => {
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 60_000), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345']) {
      expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
    }
  });
});

describe('generateTotpSecret / totpUri', () => {
  it('密钥 20 字节（160 位，RFC 4226 推荐）→ 32 个 base32 字符；两次不同', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });
  it('otpauth URI：issuer 进 label 与参数，邮箱做 URL 编码', () => {
    expect(totpUri('JBSWY3DPEHPK3PXP', 'ops+1@example.com', 'WaSelect Admin')).toBe(
      'otpauth://totp/WaSelect%20Admin:ops%2B1%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=WaSelect%20Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
