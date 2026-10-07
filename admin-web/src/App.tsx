/**
 * 职责：admin-web 根组件（F15 单元③）——登录态分流 + **左侧边栏 + 网址路由**。
 * 边界：只做"登录态装配"与"当前看哪个页"；请求语义在 api/，页面在各自组件里。
 *
 * @why 登录态交给 `AuthGate`（P1-7）：40101 时**不再卸载整个 App**，而是在当前页面上盖一层
 *      重新登录浮层——商品表单填到一半、图已传完时过期，重登后内容都还在。
 *      token 仍在 40101 当下就清掉（AuthGate 内），之后误点的请求不会带着失效身份再发。
 *
 * @why 第一批②（2026-10-08）把"当前看哪个页"从 **state 换成网址**（`router.ts`）：
 *      旧的 @limitation 写的是"刷新会回到第一个页签、浏览器后退键不切页——低频后台操作可接受"，
 *      这条**在实测里不成立**：① 订单详情是从列表点进去的，刷新一次就回到列表，
 *      运营得重新筛选、重新翻页、重新点进去；② 筛好的列表（比如"待发货"）
 *      没法发给别人——只能说"你自己去点待发货"，而对方点的可能不是同一时刻的同一批单。
 *      改成网址后这两件都成立：`#/orders?status=paid` 可以直接复制、刷新、后退。
 * @why 用 hash 而不是 History 路径：@see ./router.ts 文件头（静态站、零服务端依赖）。
 *
 * @limitation 一：**编辑态的原始数据由列表页带过来**（`editing.source`）——
 *              契约没有 `GET /admin/products/{id}`，表单页没有单条接口可用。
 *              这个形状是**被接口形状逼出来的**，不是设计偏好；将来补了单条接口，
 *              这里应改成传 id、由表单页自己取数。
 *              ⚠️ 因此**编辑商品刻意不进网址**：给一个兑现不了的深链接
 *              （刷新后表单是空的）比不给更糟（@see router.ts @limitation 一）。
 * @limitation 二：路由订阅用 `useState + hashchange` 而不是 `useSyncExternalStore`——
 *              后者的 `getSnapshot` 每次都返回一个**新对象**，会被判成"一直在变"而反复重渲染；
 *              这里只在 hashchange 时换一次 route，同一个网址下 route 是同一个实例
 *              （`OrdersPage` 的 `patch` 依赖它稳定，否则每渲染都重新拉列表）。
 *
 * @see ./AuthGate.tsx（登录态与重新登录浮层）；./api/client.ts（40101 → onUnauthorized 的语义）；
 *      ./router.ts（网址路由）；docs/地基搭建清单.md F15
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate, type SessionControls } from './AuthGate.js';
import { createAdminApi } from './api/client.js';
import { resolveApiBase } from './api/config.js';
import { login } from './api/endpoints.js';
import { createTokenStore } from './api/token-store.js';
import { BannersPage } from './banners/BannersPage.js';
import { DashboardPage } from './dashboard/DashboardPage.js';
import { OrdersPage } from './orders/OrdersPage.js';
import { RiskPage } from './risk/RiskPage.js';
import { OpsLogPage } from './opslog/OpsLogPage.js';
import { OpsPage } from './ops/OpsPage.js';
import { ProductsPage } from './products/ProductsPage.js';
import { ProductFormPage } from './products/ProductFormPage.js';
import type { AdminProductLike } from './products/api.js';
import { currentRoute, navigate, subscribe, type PageKey, type Route } from './router.js';

/** 模块级单例：store 本身无状态（读写直通 localStorage），不需要随组件生命周期重建。 */
const tokenStore = createTokenStore();

/**
 * 侧栏项（新增一个管理页就在这里加一项）。
 * @why 「工作台」排第一且是 `HOME_PAGE`：打开后台第一眼应当是"今天该干什么 + 今天卖了多少"，
 *      而不是某个业务列表（附件 §3.1：成熟平台无一例外）。
 */
const NAV: ReadonlyArray<{ key: PageKey; label: string }> = [
  { key: 'dashboard', label: '工作台' },
  { key: 'orders', label: '订单管理' },
  { key: 'products', label: '商品管理' },
  { key: 'ops', label: '运营配置' },
  { key: 'banners', label: '首页 Banner' },
  { key: 'risk', label: '风控' },
  { key: 'opslog', label: '运营日志' },
];

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

/** 登录后的壳：侧栏 + 当前页。会话失效时它**不卸载**（AuthGate 盖浮层），state 保留。 */
function AdminShell({ baseUrl, session }: { baseUrl: string; session: SessionControls }) {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => subscribe(() => setRoute(currentRoute())), []);
  const go = useCallback((next: Route) => {
    navigate(next); // 地址栏是唯一真源
    // ⚠️ 同时 setRoute 是**乐观更新**，不是第二套真源：`hashchange` 是异步派发的，
    //    只等它会让"点了详情"慢一帧（在慢机器上表现为点了没反应）。
    //    两者结果一致由 `router.unit.test.ts` 的"buildHash ↔ parseHash 往返"钉着——
    //    那条一红，这里就会开始说谎。
    setRoute(next);
  }, []);
  /** 商品保存成功后回到列表时显示一次的提示（三端联动 UI 模拟 2026-10-08）。 */
  const [flash, setFlash] = useState('');
  /** 商品编辑态：**不进网址**（@see @limitation 一）。 */
  const [editing, setEditing] = useState<Editing | null>(null);
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

  // 认不出的网址由 `parseHash` 兜成首页（router.ts @limitation：不带 id / query），这里不再兜第二遍
  const view: PageKey = route.page;

  return (
    <div className="shell">
      <aside className="sidebar">
        <span className="brand">WaSelect</span>
        <nav>
          {NAV.map((t) => (
            <button
              key={t.key}
              type="button"
              className={t.key === view ? 'nav-item nav-item-on' : 'nav-item'}
              onClick={() => {
                setEditing(null);
                go({ page: t.key, id: '', query: new URLSearchParams() });
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button type="button" className="link" onClick={logout}>
          退出登录
        </button>
      </aside>

      <main className="main">
        {view === 'dashboard' && <DashboardPage api={api} onNavigate={go} />}

        {view === 'orders' && (
          <OrdersPage
            api={api}
            route={{ page: 'orders', id: route.id, query: route.query }}
            onNavigate={go}
          />
        )}

        {view === 'ops' && <OpsPage api={api} />}

        {view === 'risk' && <RiskPage api={api} />}

        {view === 'opslog' && <OpsLogPage api={api} />}

        {view === 'banners' && (
          <BannersPage
            api={api}
            baseUrl={baseUrl}
            getToken={() => tokenStore.get()}
            onUnauthorized={onUnauthorized}
          />
        )}

        {view === 'products' &&
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
    </div>
  );
}
