// @vitest-environment jsdom
/**
 * 职责：登录页的新手可用性（AJ-410 / N1～N6）——品牌标题、显示密码、忘记密码提示、报障码单独一行、输错提醒锁定规则。
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_LOCK_MINUTES, ADMIN_LOGIN_MAX_FAILURES } from '@waselect/shared';
import { ApiError } from './api/errors.js';
import { button, click, mount, type, type Mounted } from './testing/dom.js';
import { FORGOT_PASSWORD_HINT, LoginForm } from './LoginForm.js';
import { TRACE_HINT } from './ui/trace.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function open(onLogin: () => Promise<void>): Promise<HTMLElement> {
  mounted = await mount(createElement(LoginForm, { onLogin }));
  return mounted.el;
}

describe('LoginForm：新手可用性（AJ-410）', () => {
  it('整页登录居中、写明品牌；有忘记密码提示；第三格叫手机验证码', async () => {
    const el = await open(async () => undefined);
    expect(el.querySelector('main.login-page')).not.toBeNull();
    expect(el.textContent).toContain('WaSelect 管理后台');
    expect(el.textContent).toContain(FORGOT_PASSWORD_HINT);
    expect(el.textContent).toContain('手机验证码（没开通就留空）');
    expect(el.textContent).not.toContain('二次验证码');
  });

  it('「显示密码」切换密码框明文 / 隐藏', async () => {
    const el = await open(async () => undefined);
    const pw = (): HTMLInputElement | null => el.querySelector('#login-password');
    expect(pw()?.type).toBe('password');
    await click(button(el, '显示密码'));
    expect(pw()?.type).toBe('text');
    await click(button(el, '隐藏密码'));
    expect(pw()?.type).toBe('password');
  });

  /**
   * 浏览器复验（2026-10-09）发现：点「显示密码」后焦点停在这个按钮上，新手接着按回车，
   * 回车触发的是按钮本身（又把密码藏回去），而不是登录——看起来就是"按回车没反应"。
   */
  it('🔴 点「显示密码」后焦点回到密码框（接着按回车是登录，不是再切一次）', async () => {
    const el = await open(async () => undefined);
    await click(button(el, '显示密码'));
    expect(el.ownerDocument.activeElement?.id).toBe('login-password');
  });

  // 全入口点击测试 2026-10-11：输错密码不是技术故障，不再显示报障码行（原先断言有 `${TRACE_HINT}tr-login-1`）
  it('🔴 密码不对：红字只写原因，锁定规则单独一行；不出报障码', async () => {
    const el = await open(async () => {
      throw new ApiError(40101, '未登录或登录已过期', 'tr-login-1');
    });
    await type(el.querySelector('input[type="email"]'), 'ops@example.test');
    await type(el.querySelector('#login-password'), 'x'.repeat(20));
    await click(button(el, '登录'));
    const red = el.querySelector('[role="alert"] .error')?.textContent ?? '';
    expect(red).toBe('邮箱、密码或手机验证码不正确');
    expect(el.textContent).toContain(
      `连续输错 ${ADMIN_LOGIN_MAX_FAILURES} 次会暂时锁定 ${ADMIN_LOGIN_LOCK_MINUTES} 分钟`,
    );
    expect(el.querySelector('[role="alert"] .trace-line')).toBeNull();
    expect(el.textContent).not.toContain(TRACE_HINT);
  });
});
