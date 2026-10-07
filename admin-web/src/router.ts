/**
 * 职责：管理端的**网址路由**（第一批②）——把"当前看哪个页 + 看哪一条 + 用什么筛选"放进地址栏。
 *
 * @why 用 **hash**（`#/orders?status=paid`）而不是 History API 的路径（`/orders`）：
 *      ① 管理端是 Render **静态站**（`render.yaml` 的 `runtime: static`），
 *         路径路由要靠一条 SPA rewrite 兜住深链接与刷新；hash 完全不发给服务器，
 *         **零服务端依赖**——少一个"部署配置换了就 404"的失效点。
 *      ② 它是**内部工具**，地址栏里多一个 `#` 没有实际代价，而可靠性有代价。
 *      ⚠️ 反面：路径路由更干净，且 `render.yaml` 里 rewrite 已经配了（`/* → /index.html`）。
 *         将来若确实要去掉 `#`（例如要做"按路径配 CORS / 按路径做访问统计"），
 *         换掉本文件的 `readHash` / `writeHash` 两个函数即可，页面不用动。
 *
 * @why **不引 react-router**：与 `App.tsx` 原 @limitation 同口径——需要的只是
 *      "当前看哪一页 + 一个 id + 几个筛选参数"，而路由库带来的是一整套
 *      URL↔视图约定、嵌套路由与生命周期。二十行够用的地方不引一套依赖（本仓对新增第三方依赖的默认答案是不加）。
 *
 * @why 形状是 `{ path, query }` 而不是一整串 hash 字符串：页面要读的是"页 / id / 筛选"这三样，
 *      让每个页面各自去 split 字符串，等于把解析规则复制七份（且必然漂移）。
 *
 * @limitation 一：**编辑商品不进 URL**。契约没有 `GET /admin/products/{id}`，
 *              编辑态的原始数据由列表页带过来（`App.tsx` @limitation 一）；
 *              给它一个 `#/products/:id/edit` 的深链接，是承诺一个**兑现不了**的地址
 *              （刷新后表单是空的，运营会以为商品丢了）。宁可让刷新回到列表。
 *              ⚠️ 这与订单详情相反——详情有 `GET /admin/orders/{id}`，所以 `#/orders/:id` 是真深链接。
 * @limitation 二：只认 `#/` 开头的 hash；`#` 后面不是 `/` 时（锚点）按首页处理，不报错。
 *
 * @see ../../docs/管理后台对标分析-成熟电商平台-2026-10-08.md §8-1②；./App.tsx
 */

/** 一级页面（与侧栏项一一对应；新增管理页就在这里加一项）。 */
export const PAGES = [
  'dashboard',
  'orders',
  'products',
  'ops',
  'banners',
  'risk',
  'opslog',
] as const;

export type PageKey = (typeof PAGES)[number];

/** 首页（`#` 为空 / 认不出时落到这里）。 */
export const HOME_PAGE: PageKey = 'dashboard';

export interface Route {
  /** 一级页面。 */
  page: PageKey;
  /** 二级 id（订单内部 id）。空串 = 列表态。 */
  id: string;
  /** 查询参数（筛选条件）。 */
  query: URLSearchParams;
}

export function isPage(v: string): v is PageKey {
  return (PAGES as readonly string[]).includes(v);
}

/**
 * 解析 hash → Route。
 * @why 认不出的页**回落首页**而不是抛错：地址栏是运营可以手改/粘贴的地方，
 *      粘贴错一个字就把整个后台打成白屏，是把"输入错误"升级成"不可用"。
 */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('/')) return { page: HOME_PAGE, id: '', query: new URLSearchParams() };

  const [pathPart = '', searchPart = ''] = raw.split('?');
  // 空段被滤掉 ⇒ `#/orders/` 与 `#/orders` 等价（尾斜杠不是错，不该让人白屏）
  const segments = pathPart.split('/').filter((s) => s !== '');
  const [first = '', second] = segments;
  const page = isPage(first) ? first : HOME_PAGE;

  return {
    page,
    // ❗ 页认不出时**不带**它后面的 id 与筛选：`#/nope/o-1` 不是"nope 页的 o-1"，
    //    带着它们会让首页看起来"收到了一个不知所属的条件"，比直接回落更难排查。
    id: page === first && second !== undefined ? decodeURIComponent(second) : '',
    query: page === first ? new URLSearchParams(searchPart) : new URLSearchParams(),
  };
}

/** Route → hash（含 `#`）。 */
export function buildHash(route: Route): string {
  const head = `/${route.page}${route.id === '' ? '' : `/${encodeURIComponent(route.id)}`}`;
  const qs = route.query.toString();
  return `#${head}${qs === '' ? '' : `?${qs}`}`;
}

/** 当前地址栏的路由。 */
export function currentRoute(): Route {
  return parseHash(typeof location === 'undefined' ? '' : location.hash);
}

/** 写入地址栏（会触发 `hashchange`）。相同 hash 不重复写，避免制造无意义的历史条目。 */
export function navigate(route: Partial<Route> & { page: PageKey }): void {
  const next = buildHash({
    page: route.page,
    id: route.id ?? '',
    query: route.query ?? new URLSearchParams(),
  });
  if (location.hash === next) return;
  location.hash = next;
}

/** 订阅地址栏变化（前进 / 后退 / 手改 hash 都会触发）。返回取消订阅的函数。 */
export function subscribe(fn: () => void): () => void {
  const onHash = (): void => fn();
  addEventListener('hashchange', onHash);
  return () => removeEventListener('hashchange', onHash);
}

/**
 * 取一个查询参数；空串按"没有"处理。
 * @why 单独导出：`URLSearchParams.get` 对 `?status=` 返回 `''`，
 *      而"筛选项为空"与"筛选项没给"在页面里是同一件事，不该分出第三种状态。
 */
export function queryParam(query: URLSearchParams, key: string): string {
  return query.get(key) ?? '';
}
