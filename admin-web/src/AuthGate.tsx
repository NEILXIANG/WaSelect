/**
 * 职责：登录态门卫（第三轮缺口 P1-7）——首次未登录给整页登录；会话中途失效给**浮层**重新登录，
 *      页面保持挂载；JWT 快过期时提前提醒。
 *
 * @why 浮层而不是整页切换：原实现 40101 时把整个 App 卸载成 LoginForm，
 *      商品表单里填了十几个字段、传了几张图，一过期全丢（重登后回到列表第一页）。
 *      现在页面组件**不卸载**（渲染位置不变，React 保留其 state），只在上面盖一层登录框；
 *      重新登录后浮层消失，管理员接着点"保存"即可。
 * @why 失效时仍立刻清 tokenStore：之后在浮层底下误点的请求不会带着已失效的 token 再撞一次服务端
 *      （照样 40101，浮层不变）；遮罩挡住了点击，这只是兜底。
 * @why 过期提醒（距 exp ≤ 10 分钟）只读 JWT payload、不验签（见 auth-view.ts `jwtExpMs`）。
 *
 * @limitation 一：**失败的那次请求不会自动重放**——重新登录后由管理员自己再点一次。
 *              自动重放写操作（发货 / 退款）有重复执行风险，与 client.ts @limitation 一 同一红线。
 * @limitation 二：浮层里换一个账号登录也会被接受，页面仍保留上一位填的内容——
 *              管理端只有少数几个运营账号，按"同一个人重新登录"处理，不做账号比对。
 * @limitation 三：遮罩挡的是鼠标；键盘 Tab 仍可能把焦点移到底下的页面（没有焦点陷阱）。
 *
 * @see ./auth-view.ts；./App.tsx；./LoginForm.tsx
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { expiryWarning, jwtExpMs } from './auth-view.js';
import type { TokenStore } from './api/token-store.js';
import { LoginForm } from './LoginForm.js';
import { notifyRelogin } from './ui/session-events.js';

export interface SessionControls {
  /** 40101 出口（交给请求封装的 onUnauthorized）：清 token，盖上重新登录浮层，不卸载页面。 */
  onUnauthorized: () => void;
  /** 主动退出：通知服务端作废 token（AJ-442），清本地 token，回整页登录（这是有意离开，页面状态不保留）。 */
  logout: () => void;
}

export interface AuthGateProps {
  store: TokenStore;
  /** 用邮箱口令换 JWT（失败抛 ApiError，由 LoginForm 展示）。 */
  login: (email: string, password: string, totp: string) => Promise<string>;
  children: (session: SessionControls) => ReactNode;
  /**
   * 服务端作废这枚 token（`POST /auth/admin/logout`，严格检查 A-8 / AJ-442）。
   * @why 此前退出只清本地，服务端 12 小时内仍认它——公用电脑上"退出"不等于失效。
   * @limitation 发出即不等：断网 / 服务端出错时本地照样退出（不能把人卡在已登录界面），
   *             这一枚 token 仍要等自然过期；失败不提示（人已经走了，提示没人看）。
   */
  revoke?: (token: string) => Promise<void>;
  /** 时钟（测试注入；默认 Date.now）。 */
  now?: () => number;
}

/** 过期提醒的刷新间隔：分钟级提示，30 秒一跳足够。 */
const TICK_MS = 30_000;

export function AuthGate({ store, login, children, revoke, now = Date.now }: AuthGateProps) {
  const [token, setToken] = useState<string>(() => store.get());
  /** 会话中途失效（区别于"从没登录过"）：此时页面保持挂载，只盖浮层。 */
  const [expired, setExpired] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(now()), TICK_MS);
    return () => clearInterval(t);
  }, [now]);

  const onUnauthorized = useCallback((): void => {
    store.clear();
    setExpired(true);
  }, [store]);

  const logout = useCallback((): void => {
    // 先取 token 再清：清完就拿不到要作废的那一枚了
    const current = store.get();
    if (revoke !== undefined && current !== '') void revoke(current).catch(() => undefined);
    store.clear();
    setExpired(false);
    setToken('');
  }, [store, revoke]);

  const doLogin = async (email: string, password: string, totp: string): Promise<void> => {
    const jwt = await login(email, password, totp);
    store.set(jwt);
    setToken(jwt);
    // 第 24 项：浮层里重新登录成功 → 通知各页提示区清掉残留的"登录已过期"（@see ./ui/session-events.ts）
    if (expired) notifyRelogin();
    setExpired(false);
    setNowMs(now());
  };

  if (token === '') return <LoginForm onLogin={doLogin} />;

  const warning = expired ? '' : expiryWarning(jwtExpMs(token), nowMs);
  return (
    <>
      {warning !== '' && (
        <p className="error" role="status">
          {warning}
        </p>
      )}
      {children({ onUnauthorized, logout })}
      {expired && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="重新登录">
          <div className="modal-backdrop" />
          <div className="modal-body">
            <LoginForm
              bare
              title="登录已过期，请重新登录"
              hint="页面上已填的内容都还在；重新登录后请再点一次刚才的操作（不会自动重发）。"
              onLogin={doLogin}
            />
          </div>
        </div>
      )}
    </>
  );
}
