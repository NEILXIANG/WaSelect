/**
 * 职责：admin-web 根组件（F15 单元③）——登录态分流 + 登录后的一级导航。
 * 边界：只做"登录态装配"与"当前看哪个页"；请求语义在 api/，页面在各自组件里。
 *
 * @why 登录态交给 `AuthGate`（P1-7）：40101 时**不再卸载整个 App**，而是在当前页面上盖一层
 *      重新登录浮层——商品表单填到一半、图已传完时过期，重登后内容都还在。
 *      token 仍在 40101 当下就清掉（AuthGate 内），之后误点的请求不会带着失效身份再发。
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
 * @see ./AuthGate.tsx（登录态与重新登录浮层）；./api/client.ts（40101 → onUnauthorized 的语义）；docs/地基搭建清单.md F15
 */
import { useMemo, useState } from 'react';
import { AuthGate, type SessionControls } from './AuthGate.js';
import { createAdminApi } from './api/client.js';
import { resolveApiBase } from './api/config.js';
import { login } from './api/endpoints.js';
import { createTokenStore } from './api/token-store.js';
import { BannersPage } from './banners/BannersPage.js';
import { OrdersPage } from './orders/OrdersPage.js';
import { RiskPage } from './risk/RiskPage.js';
import { OpsLogPage } from './opslog/OpsLogPage.js';
import { OpsPage } from './ops/OpsPage.js';
import { ProductsPage } from './products/ProductsPage.js';
import { ProductFormPage } from './products/ProductFormPage.js';
import type { AdminProductLike } from './products/api.js';

/** 模块级单例：store 本身无状态（读写直通 localStorage），不需要随组件生命周期重建。 */
const tokenStore = createTokenStore();

/** 一级页签（新增一个管理页就在这里加一项）。 */
const TABS = [
  { key: 'products', label: '商品管理' },
  { key: 'orders', label: '订单管理' },
  { key: 'ops', label: '运营配置' },
  { key: 'banners', label: '首页 Banner' },
  { key: 'risk', label: '风控' },
  { key: 'opslog', label: '运营日志' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** 编辑目标：id 为 null = 新建；source 是列表页带过来的原始数据（@see @limitation 一）。 */
interface Editing {
  id: string | null;
  source: AdminProductLike | null;
}

export function App() {
  const baseUrl = useMemo(() => resolveApiBase(import.meta.env), []);
  // 登录专用的请求实例：**不接 onUnauthorized**——登录接口的 40101 是"口令不对"，不是"会话失效"
  const loginApi = useMemo(() => createAdminApi({ baseUrl, getToken: () => '' }), [baseUrl]);
  return (
    <AuthGate
      store={tokenStore}
      login={(email, password, totp) => login(loginApi, { email, password, totp })}
    >
      {(session) => <AdminShell baseUrl={baseUrl} session={session} />}
    </AuthGate>
  );
}

/** 登录后的壳：一级导航 + 当前页。会话失效时它**不卸载**（AuthGate 盖浮层），state 保留。 */
function AdminShell({ baseUrl, session }: { baseUrl: string; session: SessionControls }) {
  const [tab, setTab] = useState<TabKey>('products');
  const [editing, setEditing] = useState<Editing | null>(null);
  /** 商品保存成功后回到列表时显示一次的提示（三端联动 UI 模拟 2026-10-08）。 */
  const [flash, setFlash] = useState('');
  // 40101 的唯一出口：JSON 封装与上传封装共用（KD-13：上传曾不走这里，过期后反复"HTTP 401"）
  const { onUnauthorized, logout } = session;

  const api = useMemo(
    () =>
      createAdminApi({
        baseUrl,
        getToken: () => tokenStore.get(),
        onUnauthorized,
        log: (fields) => console.info('[admin-api]', fields),
      }),
    [baseUrl, onUnauthorized],
  );

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
        <button type="button" className="link" onClick={logout}>
          退出登录
        </button>
      </nav>

      {tab === 'orders' && <OrdersPage api={api} />}

      {tab === 'ops' && <OpsPage api={api} />}

      {tab === 'risk' && <RiskPage api={api} />}

      {tab === 'opslog' && <OpsLogPage api={api} />}

      {tab === 'banners' && (
        <BannersPage
          api={api}
          baseUrl={baseUrl}
          getToken={() => tokenStore.get()}
          onUnauthorized={onUnauthorized}
        />
      )}

      {tab === 'products' &&
        (editing === null ? (
          <ProductsPage
            api={api}
            onEdit={(id, source) => {
              setFlash('');
              setEditing({ id, source: source ?? null });
            }}
            flash={flash}
          />
        ) : (
          <ProductFormPage
            api={api}
            baseUrl={baseUrl}
            getToken={() => tokenStore.get()}
            onUnauthorized={onUnauthorized}
            productId={editing.id}
            source={editing.source}
            onDone={(message) => {
              setFlash(message ?? '');
              setEditing(null);
            }}
          />
        ))}
    </main>
  );
}
