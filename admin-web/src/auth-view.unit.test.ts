/**
 * 职责：`auth-view.ts` 单测（登录错误文案 / 口令预检 / 过期提醒）。
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_LOGIN_LOCK_MINUTES,
  ADMIN_LOGIN_MAX_FAILURES,
  ADMIN_PASSWORD_MIN_LENGTH,
} from '@waselect/shared';
import { ApiError } from './api/errors.js';
import { expiryWarning, jwtExpMs, loginErrorText, loginPrecheck } from './auth-view.js';

/** 形状合格的样本邮箱（只作预检输入，不代表真实账号）。 */
const EMAIL = 'dev@waselect.test';

describe('loginErrorText（P2-43）', () => {
  // AJ-410 / N5、N6：「口令」统一为「密码」；报障码不再拼进红字（单独一行）；输错时提醒锁定规则（数字来自 shared）
  it('40101 在登录页说"邮箱、密码或手机验证码不正确"，不说"登录已过期"；报障码单独给；提醒锁定规则', () => {
    const t = loginErrorText(new ApiError(40101, '未登录或登录已过期', 'tr-1'));
    expect(t.text).toBe('邮箱、密码或手机验证码不正确');
    // 全入口点击测试 2026-10-11：输错密码不是技术故障，不再显示"把这串编号发给技术人员"（原为 'tr-1'）
    expect(t.traceId).toBe('');
    expect(t.hint).toContain(`连续输错 ${ADMIN_LOGIN_MAX_FAILURES} 次`);
    expect(t.hint).toContain(`锁定 ${ADMIN_LOGIN_LOCK_MINUTES} 分钟`);
  });

  it('42901 读 retry-after 换算分钟（向上取整）；头缺失时不编数字', () => {
    expect(loginErrorText(new ApiError(42901, 'x', 't', { retryAfterSec: 840 })).text).toContain(
      '约 14 分钟后再试',
    );
    expect(loginErrorText(new ApiError(42901, 'x', 't', { retryAfterSec: 30 })).text).toContain(
      '约 1 分钟',
    );
    expect(loginErrorText(new ApiError(42901, 'x', 't')).text).toContain('请稍后再试');
  });

  it('其它错误码透出服务端 message；非 ApiError 给通用文案', () => {
    expect(loginErrorText(new ApiError(50000, '服务器内部错误', 't')).text).toContain(
      '服务器内部错误',
    );
    expect(loginErrorText(new Error('boom')).text).toBe('登录失败，请稍后重试');
  });
});

describe('loginPrecheck：二次验证码（P1-5）', () => {
  it('🔴 留空放行（没开 TOTP）；填了就必须是 6 位数字', () => {
    const pw = 'x'.repeat(20);
    expect(loginPrecheck(EMAIL, pw, '')).toBe('');
    expect(loginPrecheck(EMAIL, pw, '012345')).toBe('');
    expect(loginPrecheck(EMAIL, pw, '12345')).toContain('6 位数字');
    expect(loginPrecheck(EMAIL, pw, '12a456')).toContain('6 位数字');
  });
  it('40101 文案提到手机验证码（开了 TOTP 时密码对、码错也是这个答复）', () => {
    expect(loginErrorText(new ApiError(40101, 'x', '')).text).toContain('手机验证码');
  });
});

describe('loginPrecheck', () => {
  it('短于 ADMIN_PASSWORD_MIN_LENGTH 拦下；恰好等于放行', () => {
    expect(loginPrecheck(EMAIL, 'a'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1))).toContain('至少');
    expect(loginPrecheck(EMAIL, 'a'.repeat(ADMIN_PASSWORD_MIN_LENGTH))).toBe('');
  });
});

/**
 * 邮箱进预检（2026-10-08 实机缺陷）。
 * @why 修订前签名里没有 email：空表单点「登录」，页面什么都不显示——
 *      `<input required>` 的原生气泡不在错误区里，管理员看不到。
 *      这里把它钉成契约：空 / 形状不对都要在错误区给出**本地**文案。
 */
describe('loginPrecheck：邮箱（空表单零反馈）', () => {
  const pw = 'x'.repeat(ADMIN_PASSWORD_MIN_LENGTH);
  it('🔴 空邮箱与纯空白都报"请填写邮箱"，不再静默无反应', () => {
    expect(loginPrecheck('', pw)).toBe('请填写邮箱');
    expect(loginPrecheck('   ', pw)).toBe('请填写邮箱');
  });
  it('形状不对（无 @ / 无域名点 / 含空格）说清格式；合格邮箱放行', () => {
    expect(loginPrecheck('plainstring', pw)).toContain('邮箱格式不正确');
    expect(loginPrecheck('a@b', pw)).toContain('邮箱格式不正确');
    expect(loginPrecheck('a b@example.com', pw)).toContain('邮箱格式不正确');
    expect(loginPrecheck(EMAIL, pw)).toBe('');
  });
  it('全部为空时先报邮箱（错误顺序=表单自上而下），而不是先报口令', () => {
    expect(loginPrecheck('', '')).toBe('请填写邮箱');
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

describe('loginErrorText：锁定（42901）不出报障码（全入口点击测试 2026-10-11）', () => {
  it('🔴 输错太多被锁定是用户侧状态，不显示求助编号', () => {
    expect(loginErrorText(new ApiError(42901, '请求过于频繁', 'tr-5')).traceId).toBe('');
  });
});

describe('loginErrorText：40301（AJ-442 起含"正式环境没开手机验证"）', () => {
  it('说清三种可能，并给出开通手机验证的出路', () => {
    const t = loginErrorText(new ApiError(40301, '无权限', 'tr-9'));
    expect(t.text).toContain('不能登录后台');
    expect(t.text).toContain('手机验证');
    expect(t.hint).toContain('npm run admin:totp');
    expect(t.traceId).toBe('tr-9');
  });
});
