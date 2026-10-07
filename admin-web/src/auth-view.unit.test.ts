/**
 * 职责：`auth-view.ts` 单测（登录错误文案 / 口令预检 / 过期提醒）。
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import { ApiError } from './api/errors.js';
import { expiryWarning, jwtExpMs, loginErrorText, loginPrecheck } from './auth-view.js';

describe('loginErrorText（P2-43）', () => {
  it('40101 在登录页说"邮箱或口令不正确"，不说"登录已过期"', () => {
    const t = loginErrorText(new ApiError(40101, '未登录或登录已过期', 'tr-1'));
    expect(t).toBe('邮箱或口令不正确（报障码：tr-1）');
  });

  it('42901 读 retry-after 换算分钟（向上取整）；头缺失时不编数字', () => {
    expect(loginErrorText(new ApiError(42901, 'x', 't', { retryAfterSec: 840 }))).toContain(
      '约 14 分钟后再试',
    );
    expect(loginErrorText(new ApiError(42901, 'x', 't', { retryAfterSec: 30 }))).toContain(
      '约 1 分钟',
    );
    expect(loginErrorText(new ApiError(42901, 'x', 't'))).toContain('请稍后再试');
  });

  it('其它错误码透出服务端 message；非 ApiError 给通用文案', () => {
    expect(loginErrorText(new ApiError(50000, '服务器内部错误', 't'))).toContain('服务器内部错误');
    expect(loginErrorText(new Error('boom'))).toBe('登录失败，请稍后重试');
  });
});

describe('loginPrecheck', () => {
  it('短于 ADMIN_PASSWORD_MIN_LENGTH 拦下；恰好等于放行', () => {
    expect(loginPrecheck('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1))).toContain('至少');
    expect(loginPrecheck('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH))).toBe('');
  });
});

describe('jwtExpMs / expiryWarning（P1-7 过期前提醒）', () => {
  const jwt = (payload: unknown): string =>
    `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

  it('读出 exp（秒 → 毫秒）；非 JWT / 无 exp 返回 null', () => {
    expect(jwtExpMs(jwt({ exp: 1_800_000_000, sub: 'a' }))).toBe(1_800_000_000_000);
    expect(jwtExpMs('not-a-jwt')).toBeNull();
    expect(jwtExpMs('a.!!!.c')).toBeNull();
    expect(jwtExpMs(jwt({ sub: 'a' }))).toBeNull();
  });

  it('距过期 > 10 分钟不提醒；≤ 10 分钟提醒剩余分钟；已过期给另一句', () => {
    const exp = 1_000_000_000_000;
    expect(expiryWarning(exp, exp - 11 * 60_000)).toBe('');
    expect(expiryWarning(exp, exp - 10 * 60_000)).toContain('约 10 分钟');
    expect(expiryWarning(exp, exp + 1)).toContain('已过期');
    expect(expiryWarning(null, 0)).toBe('');
  });
});
