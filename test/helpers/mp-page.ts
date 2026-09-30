/**
 * 职责：小程序**页面薄壳**的最小测试宿主——把 `Page({...})` 注册的对象真的跑起来（AJ-226）。
 *
 * @why 约束十一把页面逻辑赶进了 `*.vm.js`，但**接线**（什么时候取数、结果回来落不落页面、
 *      标志位谁清）只能住在 `index.js` 里，而它此前没有任何办法被执行：
 *      现有"防复发"用例全是**数源码里某个字符串出现几次**——它能证明"这行字还在"，
 *      证明不了"行为是对的"。2026-09-30 复核时实际踩到：首页 `reload` 与 `loadMore`
 *      各领一次号、各判三次过期（字符串计数全绿），而二者共用一个序号槽 ⇒
 *      切分类在途时触底，新分类的响应被判过期丢弃、`loading` 永不清。
 *      这类缺陷只有"真的调一遍方法、看 data 变成什么"才抓得到。
 *
 * @why 只模拟三样：全局 `Page`（收下定义）、全局 `getApp`（给 `app.globalData`）、
 *      `setData`（浅合并进 `data`）。页面里其它东西（vm、utils）都是**真的**。
 *
 * @limitation 一：**不渲染 WXML**——绑定写错、样式、真机兼容性它都管不了（约束十一原文同）。
 * @limitation 二：`setData` 只做**浅合并**，不支持 `'a.b': 1` / `'list[0].x'` 这类数据路径。
 *              遇到路径写法会直接抛错（而不是静默当成一个怪键）——页面真用到时再扩，别让它假绿。
 * @limitation 三：生命周期不会自动触发（`onLoad` / `onShow` 要用例自己调），
 *              也没有页面栈；`wx` 全局由用例按需 `vi.stubGlobal`。
 * @limitation 四：每次 `loadPage` 都 `vi.resetModules()`——页面模块顶层的
 *              `const app = getApp()` 才会重新求值；代价是同一用例里加载两个页面时
 *              它们拿到的是两份模块实例（与真机"每页一个实例"一致）。
 *
 * @see CLAUDE.md 约束十一；docs/自主决策记录.md AJ-226；
 *      docs/全量逐行代码审查报告-2026-09-29.md 第七节机制 4（页面级 harness）
 */
import { vi } from 'vitest';

/** 被加载起来的页面实例：`data` 是当前视图数据，其余是页面定义里的方法与实例字段。 */
export type LoadedPage = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
} & Record<string, unknown>;

export interface LoadPageOptions {
  /** `getApp().globalData`（页面用到什么就给什么：`api` / `apiBase` / `cart` …）。 */
  globalData: Record<string, unknown>;
}

/**
 * 加载一个页面薄壳并返回可调用的实例。
 * @param moduleUrl 页面 `index.js` 的绝对 URL（用例里写 `new URL('./index.js', import.meta.url).href`）
 */
export async function loadPage(moduleUrl: string, opts: LoadPageOptions): Promise<LoadedPage> {
  let def: Record<string, unknown> | undefined;
  vi.resetModules();
  vi.stubGlobal('getApp', () => ({ globalData: opts.globalData }));
  vi.stubGlobal('Page', (d: Record<string, unknown>) => {
    def = d;
  });
  await import(/* @vite-ignore */ moduleUrl);
  if (def === undefined) throw new Error(`${moduleUrl} 没有调用 Page({...})：它不是页面文件`);

  const { data, ...rest } = def;
  const page: LoadedPage = {
    ...rest,
    // 深拷贝初始 data：页面定义里的数组 / 对象不能被上一个用例改脏
    data: structuredClone((data ?? {}) as Record<string, unknown>),
    setData(patch: Record<string, unknown>): void {
      for (const key of Object.keys(patch)) {
        if (/[.[]/.test(key)) {
          throw new Error(`mp-page 不支持数据路径写法 setData({'${key}': …})（见 @limitation 二）`);
        }
      }
      this.data = { ...this.data, ...patch };
    },
  };
  // 方法里的 this 必须是实例本身（真机同）
  for (const [k, v] of Object.entries(page)) {
    if (typeof v === 'function') page[k] = (v as (...a: unknown[]) => unknown).bind(page);
  }
  return page;
}

/** 一个可以从外面兑现 / 拒绝的请求：用来精确编排"哪个响应先回来"。 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
