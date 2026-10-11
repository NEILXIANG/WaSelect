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
 * @limitation 一：商品编辑进网址（代理 G8，第二轮审计 2026-10-11）：`#/products/<id>` / `#/products/new`。
 *              从列表点进来时原始数据由列表带过来（`editSource`，不多发请求）；刷新 / 链接打开的由
 *              products/ProductEditRoute.tsx 用 `findProductById` 取数后再挂表单（契约仍没有按 id 取单件的接口）。
 * @limitation 二：路由订阅用 `useState + hashchange` 而不是 `useSyncExternalStore`——
 *              后者的 `getSnapshot` 每次都返回一个**新对象**，会被判成"一直在变"而反复重渲染；
 *              这里只在 hashchange 时换一次 route，同一个网址下 route 是同一个实例
 *              （`OrdersPage` 的 `patch` 依赖它稳定，否则每渲染都重新拉列表）。
 *
 * @see ./AuthGate.tsx（登录态与重新登录浮层）；./api/client.ts（40101 → onUnauthorized 的语义）；
 *      ./router.ts（网址路由）；docs/地基搭建清单.md F15
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate, type SessionControls } from './AuthGate.js';
import { createAdminApi } from './api/client.js';
import { resolveApiBase } from './api/config.js';
import { adminLogout, login } from './api/endpoints.js';
import { createTokenStore } from './api/token-store.js';
import { BannersPage } from './banners/BannersPage.js';
import { DashboardPage } from './dashboard/DashboardPage.js';
import { OrdersPage } from './orders/OrdersPage.js';
import { RiskPage } from './risk/RiskPage.js';
import { CustomersPage } from './customers/CustomersPage.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { OpsLogPage } from './opslog/OpsLogPage.js';
import { OpsPage } from './ops/OpsPage.js';
import { ProductsPage } from './products/ProductsPage.js';
import { NEW_PRODUCT_ROUTE_ID, ProductEditRoute } from './products/ProductEditRoute.js';
import type { AdminProductLike } from './products/api.js';
import {
  buildHash,
  currentRoute,
  navigate,
  subscribe,
  type PageKey,
  type Route,
} from './router.js';
import { ConfirmDialog } from './ui/confirm.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { createErrorReporter, describeThrown } from './ui/error-report.js';
import { LEAVE_UNSAVED_SPEC } from './ui/leave-spec.js';
import { BrandMark, LogoutIcon, NavIcon } from './ui/icons.js';
import { UnsavedProvider, useBeforeUnload, useDirtyRegistry } from './ui/unsaved.js';

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
  { key: 'customers', label: '客户' },
  { key: 'products', label: '商品管理' },
  { key: 'ops', label: '运营配置' },
  { key: 'banners', label: '首页 Banner' },
  { key: 'risk', label: '风控' },
  { key: 'opslog', label: '运营日志' },
  { key: 'settings', label: '设置' },
];

export function App() {
  const baseUrl = useMemo(() => resolveApiBase(import.meta.env), []);
  // 登录专用的请求实例：**不接 onUnauthorized**——登录接口的 40101 是"口令不对"，不是"会话失效"
  const loginApi = useMemo(() => createAdminApi({ baseUrl, getToken: () => '' }), [baseUrl]);
  return (
    <AuthGate
      store={tokenStore}
      login={(email, password, totp) => login(loginApi, { email, password, totp })}
      // 退出时服务端作废（AJ-442）：单独的请求实例，token 取调用时那一枚（本地随后就清掉了）；
      // 不接 onUnauthorized——这枚 token 若已失效，401 不该再弹"重新登录"浮层
      revoke={(t) => adminLogout(createAdminApi({ baseUrl, getToken: () => t }))}
    >
      {(session) => <AdminShell baseUrl={baseUrl} session={session} />}
    </AuthGate>
  );
}

/** 登录后的壳：侧栏 + 当前页。会话失效时它**不卸载**（AuthGate 盖浮层），state 保留。 */
function AdminShell({ baseUrl, session }: { baseUrl: string; session: SessionControls }) {
  const [route, setRoute] = useState<Route>(currentRoute);
  /** 当前页面有没有未保存的改动（第一批⑥：由表单页上报，@see ../ui/unsaved.tsx）。 */
  const { dirty, markDirty, clear: clearDirty } = useDirtyRegistry();
  useBeforeUnload(dirty);
  /**
   * `leave` 读 ref 而不是闭包里的 `dirty`：它要传给 OrdersPage 当 `onNavigate`，
   * 而 OrdersPage 的 `patch` → `load` 依赖它——身份随脏态变，就会在"打一个字"时重拉列表。
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** 被脏态拦下的那次导航：点了二次确认才真正走（`@see leave`）。 */
  const [pendingNav, setPendingNav] = useState<Route | null>(null);
  /**
   * 被拦下的这次导航是不是来自地址栏（后退 / 前进 / 手改 hash，下方 subscribe 那段）。
   * @why 那条路径已经"先回滚"压了一条当前页（pushState）；确认离开时要**退回**那一步，而不是再 go 一次——
   *      再 go 会多压一条，按后退离开、确认之后再按后退，又回到刚离开的那页（代理 S7，第二轮审计浏览器实测）。
   */
  const pendingFromHistoryRef = useRef(false);
  const go = useCallback((next: Route) => {
    navigate(next); // 地址栏是唯一真源
    // ⚠️ 同时 setRoute 是**乐观更新**，不是第二套真源：`hashchange` 是异步派发的，
    //    只等它会让"点了详情"慢一帧（在慢机器上表现为点了没反应）。
    //    两者结果一致由 `router.unit.test.ts` 的"buildHash ↔ parseHash 往返"钉着——
    //    那条一红，这里就会开始说谎。
    setRoute(next);
  }, []);

  /**
   * 带脏态拦截的导航（第一批⑥）。
   *
   * @why 必须在**这一处**拦：侧栏与订单页（「返回列表」「换一单」、筛选）都经由它导航，
   *      在每个调用点各判一次等于复制 N 份且必然漏。看板没有表单，仍拿未拦截的 `go`。
   * 浏览器后退 / 前进 / 手改地址栏走的是 hashchange，由下方 `subscribe` 那段做同样的拦截。
   * @why 保存成功后**不该**弹：`onDone` 里表单页自己会 reset 脏态（见 useFormDirty），
   *      所以这里只要跟着 dirty 走就够了，不需要给"刚保存过"单开一个例外。
   */
  const leave = useCallback(
    (next: Route, onLeave?: () => void) => {
      if (dirtyRef.current) {
        pendingFromHistoryRef.current = false;
        setPendingNav(next);
        return;
      }
      onLeave?.();
      go(next);
    },
    [go],
  );
  /** 商品保存成功后回到列表时显示一次的提示（三端联动 UI 模拟 2026-10-08）。 */
  const [flash, setFlash] = useState('');
  /** 从列表点「编辑」时带过来的那一版（id 与网址对得上才用，@see @limitation 一）。 */
  const editSource = useRef<AdminProductLike | null>(null);

  /**
   * 地址栏变化（后退 / 前进 / 手改 hash）：同样要过脏态拦截。
   * @why hashchange 不可取消，只能"先回滚再问"：用 `pushState` 把地址写回当前页（它不触发 hashchange，
   *      不会自激），再弹同一个二次确认；确认后照常 `go(next)`。批次复审发现此前这条路径完全绕过提醒。
   * @tradeoff 回滚用 push 而不是 replace：replace 会覆盖掉后退到的那一条历史，再按后退就跳过了它；
   *           push 的代价是"前进"栈被清空——比丢一条后退记录更可接受。确认离开时 `history.back()` 退掉这条（@see pendingFromHistoryRef）。
   */
  const shownRef = useRef(route);
  shownRef.current = route;
  useEffect(
    () =>
      subscribe(() => {
        const next = currentRoute();
        // 目标就是当前页（例如刚 pushState 回滚后又收到一次 hashchange）：什么都不做，
        // 否则会把"待去的页"改写成当前页，确认后原地不动
        if (buildHash(next) === buildHash(shownRef.current)) return;
        if (dirtyRef.current) {
          history.pushState(null, '', buildHash(shownRef.current));
          pendingFromHistoryRef.current = true;
          setPendingNav(next);
          return;
        }
        setRoute(next);
      }),
    [],
  );
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

  /**
   * 前端报错上报（AJ-421）：**单独的请求实例**，不接 `onUnauthorized`——会话过期时上报安静失败，
   * 不会凭空弹出"重新登录"浮层（上报是顺便的事，不能产生用户可见的副作用）。
   */
  const reporter = useMemo(() => {
    const reportApi = createAdminApi({ baseUrl, getToken: () => tokenStore.get() });
    return createErrorReporter({
      send: (body) => reportApi({ path: '/api/v1/admin/client-errors', method: 'POST', body }),
    });
  }, [baseUrl]);
  /** 全局监听读 ref：监听只挂一次，页名要取"出错那一刻"的当前页。 */
  const viewRef = useRef(view);
  viewRef.current = view;
  // 错误边界只接得住渲染期异常；事件处理函数与异步回调里的错误走这两个全局事件（ErrorBoundary @limitation 一）
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      const d = describeThrown(e.error ?? e.message);
      reporter.report({ kind: 'error', message: d.message, stack: d.stack, page: viewRef.current });
    };
    const onRejection = (e: Event): void => {
      const d = describeThrown((e as Event & { reason?: unknown }).reason);
      reporter.report({
        kind: 'rejection',
        message: d.message,
        stack: d.stack,
        page: viewRef.current,
      });
    };
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    return () => {
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    };
  }, [reporter]);

  const body: JSX.Element = (
    <>
      {view === 'dashboard' && <DashboardPage api={api} onNavigate={go} />}

      {view === 'orders' && (
        <OrdersPage
          api={api}
          route={{ page: 'orders', id: route.id, query: route.query }}
          // 走 leave 而非 go：订单详情里有发货 / 退款 / 改址 / 备注草稿，「返回列表」「换一单」都要拦
          onNavigate={leave}
        />
      )}

      {/* AJ-404：客户（只读 + 详情页拉黑 / 解除）与设置（只读）；客户详情是真深链接 `#/customers/:id` */}
      {view === 'customers' && (
        <CustomersPage
          api={api}
          route={{ page: 'customers', id: route.id, query: route.query }}
          onNavigate={leave}
        />
      )}

      {view === 'settings' && <SettingsPage api={api} />}

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
        (route.id === '' ? (
          <ProductsPage
            api={api}
            // 审查 2026-10-09：筛选 / 页码进地址栏（同订单页）；走 leave 以过脏态拦截
            route={{ page: 'products', id: '', query: route.query }}
            onNavigate={leave}
            onEdit={(id, source) => {
              setFlash('');
              editSource.current = source ?? null;
              // G8：编辑进网址（列表的筛选一并带上，回列表时还原）
              go({ page: 'products', id: id ?? NEW_PRODUCT_ROUTE_ID, query: route.query });
            }}
            flash={flash}
          />
        ) : (
          <ProductEditRoute
            key={route.id}
            api={api}
            baseUrl={baseUrl}
            getToken={() => tokenStore.get()}
            onUnauthorized={onUnauthorized}
            routeId={route.id}
            cached={editSource.current}
            onDone={(message) => {
              setFlash(message ?? '');
              editSource.current = null;
              go({ page: 'products', id: '', query: route.query });
            }}
          />
        ))}
    </>
  );

  return (
    <div className="shell">
      <UnsavedProvider dirty={dirty} markDirty={markDirty}>
        {/* AJ-411：M3 导航抽屉——图标 + 文字（文字不省，AJ-410），选中项是胶囊底色 + aria-current */}
        <aside className="sidebar">
          <span className="brand">
            <BrandMark />
            WaSelect
          </span>
          <nav aria-label="主导航">
            {NAV.map((t) => (
              <button
                key={t.key}
                type="button"
                className={t.key === view ? 'nav-item nav-item-on' : 'nav-item'}
                aria-current={t.key === view ? 'page' : undefined}
                onClick={() => leave({ page: t.key, id: '', query: new URLSearchParams() })}
              >
                <NavIcon page={t.key} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <button type="button" className="nav-logout" onClick={logout}>
            <LogoutIcon />
            <span>退出登录</span>
          </button>
        </aside>

        <main className="main">
          {/* 页面级错误边界（AJ-421）：一页坏了只换这一块，侧栏照常；换页 / 换一单即复位 */}
          <ErrorBoundary page={view} resetKey={`${view}/${route.id}`} reporter={reporter}>
            {body}
          </ErrorBoundary>
        </main>
      </UnsavedProvider>
      {pendingNav !== null && (
        <ConfirmDialog
          spec={LEAVE_UNSAVED_SPEC}
          onConfirm={() => {
            clearDirty();
            // ref 同步置干净：go 引发的 hashchange 可能先于重渲染到达，读到旧的 dirty 会再拦一次
            dirtyRef.current = false;
            if (pendingFromHistoryRef.current) {
              // 地址栏来的：退回守卫压的那一条，地址落在原本要去的那页（不多压历史）；
              // 同时乐观 setRoute（同 go 的理由），随后到达的 hashchange 发现已是当前页即不再处理
              pendingFromHistoryRef.current = false;
              setRoute(pendingNav);
              history.back();
            } else {
              go(pendingNav);
            }
            setPendingNav(null);
          }}
          onCancel={() => {
            pendingFromHistoryRef.current = false;
            setPendingNav(null);
          }}
        />
      )}
    </div>
  );
}
