// @vitest-environment jsdom
/**
 * 职责：`AuthGate` 的组件行为——会话中途失效时**不卸载页面**，盖浮层重新登录，填了一半的内容保留（P1-7）。
 *
 * @why 原实现 40101 时整个 App 换成 LoginForm：商品表单的十几个字段与已上传的图一过期全丢。
 * @see ./AuthGate.tsx
 */
import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from './api/errors.js';
import type { TokenStore } from './api/token-store.js';
import { AuthGate, type SessionControls } from './AuthGate.js';
import { button, click, flush, mount, type, type Mounted } from './testing/dom.js';
import { onRelogin } from './ui/session-events.js';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function memStore(initial: string): TokenStore & { value: () => string } {
  let v = initial;
  return {
    get: () => v,
    set: (t) => {
      v = t;
    },
    clear: () => {
      v = '';
    },
    value: () => v,
  };
}

/** 一个"填了一半的页面"：受控输入 + 一个模拟请求 40101 的按钮。 */
function DraftPage({ session }: { session: SessionControls }) {
  const [draft, setDraft] = useState('');
  return createElement(
    'div',
    null,
    createElement('input', {
      'data-testid': 'draft',
      value: draft,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    }),
    createElement('button', { type: 'button', onClick: session.onUnauthorized }, '模拟 40101'),
  );
}

const PASSWORD = 'correct-horse-battery';

async function fillLogin(root: Element, password = PASSWORD): Promise<void> {
  const dialog = root.querySelector('[role="dialog"]') ?? root;
  await type(dialog.querySelector('input[type="email"]'), 'ops@example.test');
  await type(dialog.querySelector('input[type="password"]'), password);
  await click(button(dialog, '登录'));
}

describe('AuthGate（P1-7：过期浮层，不卸载页面）', () => {
  it('🔴 填了一半 → 40101 → 浮层出现、输入仍在 → 重新登录 → 浮层消失、输入仍在', async () => {
    const store = memStore('old-token');
    const logins: string[] = [];
    mounted = await mount(
      createElement(AuthGate, {
        store,
        login: async (email: string) => {
          logins.push(email);
          return 'new-token';
        },
        children: (s: SessionControls) => createElement(DraftPage, { session: s }),
      }),
    );
    const el = mounted.el;
    const input = (): HTMLInputElement | null => el.querySelector('[data-testid="draft"]');
    await type(input(), '資生堂 クレンジングオイル');

    await click(button(el, '模拟 40101'));
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el.textContent).toContain('登录已过期');
    expect(input()?.value).toBe('資生堂 クレンジングオイル');
    expect(store.value()).toBe(''); // 失效 token 当场清掉

    await fillLogin(el);
    await flush();
    expect(logins).toEqual(['ops@example.test']);
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(input()?.value).toBe('資生堂 クレンジングオイル');
    expect(store.value()).toBe('new-token');
  });

  // 第 24 项（2026-10-10）：浮层里重新登录成功要发出"已重新登录"，页面的提示区据此清掉残留的"登录已过期"
  it('🔴 浮层里重新登录成功 → 通知一次 relogin；登录失败不通知', async () => {
    const heard: number[] = [];
    const off = onRelogin(() => heard.push(1));
    try {
      let ok = false;
      mounted = await mount(
        createElement(AuthGate, {
          store: memStore('old-token'),
          login: async () => {
            if (!ok) throw new ApiError(40101, '未登录或登录已过期', 'tr-1');
            return 'new-token';
          },
          children: (s: SessionControls) => createElement(DraftPage, { session: s }),
        }),
      );
      const el = mounted.el;
      await click(button(el, '模拟 40101'));
      await fillLogin(el);
      await flush();
      expect(heard).toEqual([]);
      ok = true;
      await fillLogin(el);
      await flush();
      expect(heard).toEqual([1]);
    } finally {
      off();
    }
  });

  // AJ-410 / N5：文案「口令 / 二次验证码」统一为「密码 / 手机验证码」
  it('浮层里密码不对（40101）→ 说"邮箱、密码或手机验证码不正确"，浮层不消失，页面仍在', async () => {
    const store = memStore('old-token');
    mounted = await mount(
      createElement(AuthGate, {
        store,
        login: async () => {
          throw new ApiError(40101, '未登录或登录已过期', 'tr-x');
        },
        children: (s: SessionControls) => createElement(DraftPage, { session: s }),
      }),
    );
    const el = mounted.el;
    await click(button(el, '模拟 40101'));
    await fillLogin(el);
    expect(el.textContent).toContain('邮箱、密码或手机验证码不正确');
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="draft"]')).not.toBeNull();
  });

  it('从没登录过 → 整页登录（没有页面可保留）', async () => {
    mounted = await mount(
      createElement(AuthGate, {
        store: memStore(''),
        login: async () => 't',
        children: (s: SessionControls) => createElement(DraftPage, { session: s }),
      }),
    );
    // AJ-410 / N1：整页登录写明品牌「WaSelect 管理后台」（原标题「管理后台登录」）
    expect(mounted.el.textContent).toContain('WaSelect 管理后台');
    expect(mounted.el.querySelector('[data-testid="draft"]')).toBeNull();
  });

  it('JWT 距过期 ≤ 10 分钟 → 页面顶部提醒尽快保存', async () => {
    const exp = 2_000_000_000; // 秒
    const payload = btoa(JSON.stringify({ exp })).replace(/=+$/, '');
    mounted = await mount(
      createElement(AuthGate, {
        store: memStore(`h.${payload}.s`),
        login: async () => 't',
        now: () => exp * 1000 - 5 * 60_000,
        children: (s: SessionControls) => createElement(DraftPage, { session: s }),
      }),
    );
    expect(mounted.el.textContent).toContain('约 5 分钟后过期');
  });

  it('🔴 主动退出（AJ-442）：先拿当前 token 通知服务端作废，再清本地、回整页登录', async () => {
    const store = memStore('tok-live');
    const revoked: string[] = [];
    mounted = await mount(
      createElement(AuthGate, {
        store,
        login: async () => 't',
        revoke: async (t: string) => {
          revoked.push(t);
        },
        children: (s: SessionControls) =>
          createElement('button', { type: 'button', onClick: s.logout }, '退出'),
      }),
    );
    await click(button(mounted.el, '退出'));
    expect(revoked).toEqual(['tok-live']);
    expect(store.value()).toBe('');
    expect(mounted.el.textContent).toContain('WaSelect 管理后台');
  });

  it('退出时服务端作废失败（断网）→ 本地照样退出，不卡在已登录界面', async () => {
    const store = memStore('tok-live');
    mounted = await mount(
      createElement(AuthGate, {
        store,
        login: async () => 't',
        revoke: async () => {
          throw new Error('network down');
        },
        children: (s: SessionControls) =>
          createElement('button', { type: 'button', onClick: s.logout }, '退出'),
      }),
    );
    await click(button(mounted.el, '退出'));
    expect(store.value()).toBe('');
    expect(mounted.el.textContent).toContain('WaSelect 管理后台');
  });
});
