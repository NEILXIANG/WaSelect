/**
 * 职责：admin-web 根组件（F15 单元③）——登录态分流：无 token → 登录页；有 token → 占位首页。
 * 边界：只做"登录态装配"；请求语义在 api/，表单在 LoginForm.tsx。
 *
 * @why token 状态放 React state 而不是只读 tokenStore：
 *      40101 时封装层调 onUnauthorized → 这里清 store + 置空 state → **立刻**渲染登录页；
 *      只清 store 不动 state 的话，页面还停在"已登录"壳里，下一次点击才报错——
 *      管理员会以为"发货发出去了"，实际请求根本没带上有效身份。
 *
 * @limitation 占位首页当前**不调任何业务接口**（订单/商品列表在 I1 之后才存在）——
 *             它的唯一职责是证明"登录态 → 受保护页"这条链通了；与 F14「不空造组件」同口径，
 *             但登录占位是清单 F15 点名要的最小集。
 *
 * @see ./api/client.ts（40101 → onUnauthorized 的语义）；docs/地基搭建清单.md F15
 */
import { useMemo, useState } from 'react';
import { createAdminApi } from './api/client.js';
import { resolveApiBase } from './api/config.js';
import { login } from './api/endpoints.js';
import { createTokenStore } from './api/token-store.js';
import { LoginForm } from './LoginForm.js';

/** 模块级单例：store 本身无状态（读写直通 localStorage），不需要随组件生命周期重建。 */
const tokenStore = createTokenStore();

export function App() {
  const [token, setToken] = useState<string>(() => tokenStore.get());

  const api = useMemo(
    () =>
      createAdminApi({
        baseUrl: resolveApiBase(import.meta.env),
        getToken: () => tokenStore.get(),
        onUnauthorized: () => {
          // 管理端没有静默重登（AJ-83）：token 失效的唯一出路是回登录页重新输密码
          tokenStore.clear();
          setToken('');
        },
        log: (fields) => console.info('[admin-api]', fields),
      }),
    [],
  );

  if (!token) {
    return (
      <LoginForm
        onLogin={async (email, password) => {
          const jwt = await login(api, { email, password });
          tokenStore.set(jwt);
          setToken(jwt);
        }}
      />
    );
  }

  return (
    <main className="page">
      <section className="card">
        <h1 className="title">管理后台</h1>
        <p className="muted">已登录。订单与商品管理将在订单域（I1）上线后开放。</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            tokenStore.clear();
            setToken('');
          }}
        >
          退出登录
        </button>
      </section>
    </main>
  );
}
