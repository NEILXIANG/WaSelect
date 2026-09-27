/**
 * 职责：admin-web 根组件（F15 单元③）——登录态分流 + 登录后的一级导航。
 * 边界：只做"登录态装配"与"当前看哪个页"；请求语义在 api/，页面在各自组件里。
 *
 * @why token 状态放 React state 而不是只读 tokenStore：
 *      40101 时封装层调 onUnauthorized → 这里清 store + 置空 state → **立刻**渲染登录页；
 *      只清 store 不动 state 的话，页面还停在"已登录"壳里，下一次点击才报错——
 *      管理员会以为"发货发出去了"，实际请求根本没带上有效身份。
 *
 * @why 页面切换是 **state 而不是 react-router**（ProductsPage @limitation 一 同口径）：
 *      管理端一共几个页面，路由库带来的是一整套 URL↔视图约定与依赖，
 *      而这里只需要"当前看哪个页"。⚠️ 代价是刷新会回到第一个页签、
 *      浏览器后退键不切页——低频后台操作可接受。
 *
 * @limitation 一：**编辑态的原始数据由列表页带过来**（`editing.source`）——
 *              契约没有 `GET /admin/products/{id}`，表单页没有单条接口可用。
 *              这个形状是**被接口形状逼出来的**，不是设计偏好；将来补了单条接口，
 *              这里应改成传 id、由表单页自己取数。
 *
 * @see ./api/client.ts（40101 → onUnauthorized 的语义）；docs/地基搭建清单.md F15
 */
import { useMemo, useState } from 'react';
import { createAdminApi } from './api/client.js';
import { resolveApiBase } from './api/config.js';
import { login } from './api/endpoints.js';
import { createTokenStore } from './api/token-store.js';
import { LoginForm } from './LoginForm.js';
import { ProductsPage } from './products/ProductsPage.js';
import { ProductFormPage } from './products/ProductFormPage.js';
import type { AdminProductLike } from './products/api.js';

/** 模块级单例：store 本身无状态（读写直通 localStorage），不需要随组件生命周期重建。 */
const tokenStore = createTokenStore();

/** 一级页签（新增一个管理页就在这里加一项）。 */
const TABS = [{ key: 'products', label: '商品管理' }] as const;

type TabKey = (typeof TABS)[number]['key'];

/** 编辑目标：id 为 null = 新建；source 是列表页带过来的原始数据（@see @limitation 一）。 */
interface Editing {
  id: string | null;
  source: AdminProductLike | null;
}

export function App() {
  const [token, setToken] = useState<string>(() => tokenStore.get());
  const [tab, setTab] = useState<TabKey>('products');
  const [editing, setEditing] = useState<Editing | null>(null);

  const baseUrl = useMemo(() => resolveApiBase(import.meta.env), []);

  const api = useMemo(
    () =>
      createAdminApi({
        baseUrl,
        getToken: () => tokenStore.get(),
        onUnauthorized: () => {
          // 管理端没有静默重登（AJ-83）：token 失效的唯一出路是回登录页重新输密码
          tokenStore.clear();
          setToken('');
        },
        log: (fields) => console.info('[admin-api]', fields),
      }),
    [baseUrl],
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
      <nav className="nav">
        <span className="brand">WaSelect 管理后台</span>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={t.key === tab && editing === null ? 'chip chip-on' : 'chip'}
            onClick={() => {
              setTab(t.key);
              setEditing(null);
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="link"
          onClick={() => {
            tokenStore.clear();
            setToken('');
          }}
        >
          退出登录
        </button>
      </nav>

      {tab === 'products' &&
        (editing === null ? (
          <ProductsPage
            api={api}
            onEdit={(id, source) => setEditing({ id, source: source ?? null })}
          />
        ) : (
          <ProductFormPage
            api={api}
            baseUrl={baseUrl}
            getToken={() => tokenStore.get()}
            productId={editing.id}
            source={editing.source}
            onDone={() => setEditing(null)}
          />
        ))}
    </main>
  );
}
