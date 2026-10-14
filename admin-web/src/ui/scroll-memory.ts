/**
 * 职责：主区滚动位置的记忆——后退 / 前进回到原处，点链接 / 侧栏进新页面从页顶开始（全入口点击测试 2026-10-11）。
 *
 * @why 实测：订单列表滚到下面点开一单，返回后回到页顶，要重新往下找；主流后台返回时停在原处。
 *      原先整个应用没有任何滚动处理：列表 → 详情碰巧回到页顶（详情先渲染空态），返回列表也因先渲染空列表被夹到 0。
 * @why "是不是点出来的"用一次性标记（`markPush`）：hash 路由下点链接与后退都只触发 hashchange，分不出来；
 *      应用内的 `navigate()` 与页面里 `#/…` 链接点击都会先打标记，没标记的换页就当后退 / 前进 / 手改地址。
 * @limitation 只记在内存里（当前页签有效，刷新即忘）；位置按完整网址（含筛选与页码）记。
 *             恢复要等列表取数撑开高度——调用方按帧重试，最多约 2 秒，取不到那么高就停在能到的最下面。
 * @limitation 滚动容器**随断点切换**（窄屏滚文档、宽屏滚 `.main`）——读写一律经
 *             `readScrollTop` / `writeScrollTop` / `maxScrollTop`，不要在调用方直接碰 `scrollTop`
 *             （体验审查 2026-10-15，P1-3：只碰 `.main` 会让窄屏的回顶与记忆双双失效）。
 */
const memory = new Map<string, number>();
let pushPending = false;

/** 记下某个网址当前的滚动位置（主区 scroll 事件里调）。 */
export function rememberScroll(key: string, top: number): void {
  memory.set(key, Math.max(0, Math.round(top)));
}

/** 下一次换页是点出来的（应用内 navigate / `#/` 链接点击）。 */
export function markPush(): void {
  pushPending = true;
}

/** 取走"点出来的"标记（用掉即清）。 */
export function consumePush(): boolean {
  const p = pushPending;
  pushPending = false;
  return p;
}

/** 换到 key 之后该滚到哪：点出来的 → 0；后退 / 前进 → 记下的位置（没记过 → 0）。 */
export function scrollTarget(key: string, pushed: boolean): number {
  if (pushed) return 0;
  return memory.get(key) ?? 0;
}

/** 测试用。 */
export function resetScrollMemory(): void {
  memory.clear();
  pushPending = false;
}

/**
 * 这次点击会不会在**当前页**换页（不带修饰键的左键单击）。
 * @why 三天提交复查 2026-10-12：Cmd / Ctrl / Shift 点链接是在新标签 / 新窗口打开，当前页没换页；
 *      原先也 markPush，下一次后退 / 前进就被当成"点出来的"、回到页顶而不是原来的位置。
 */
export function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * 主区的滚动位置：**窄屏滚的是整个文档，宽屏滚的是 `.main` 自己**
 * （app.css：只有 `@media (min-width: 56.0625rem)` 才给 `.main` 限高 + `overflow-y: auto`；
 *  窄屏是顶栏布局、整页滚，更符合手机习惯）。
 *
 * @why 体验审查 2026-10-15（P1-3）：换页与记忆原先只认 `.main.scrollTop`，
 *      于是窄屏下"换页回顶"和"后退回到原处"**双双失效**——`.main` 在窄屏里根本不滚，
 *      `scrollTop` 恒为 0，它的 `scroll` 事件也永远不会派发（位置一个都没记下）。
 * @why 三个函数一律**两边都做 / 两边都取最大**，不去探测"这一刻谁是滚动容器"：
 *      ① 读 `getComputedStyle(main).overflowY` 判不出——CSS 规范里 `overflow-x: auto`
 *         会把 `overflow-y: visible` 的**计算值**也变成 `auto`（app.css 自己记着这个坑：
 *         宽屏那条注释），窄屏会被误判成"主区是滚动容器"；
 *      ② 读 `matchMedia('(min-width: …)')` 等于把 CSS 里的 56.0625rem 抄成第二份，
 *         改一处忘一处（本仓的单一事实来源纪律）。
 *      而"两边都做"在两种布局下各自有一边天然是空操作：宽屏文档不滚（`.shell` 就是一屏高），
 *      窄屏 `.main` 不滚（高度随内容长）。读的时候取较大值——不滚的那一侧恒为 0。
 */
export function readScrollTop(main: HTMLElement | null): number {
  return Math.max(main?.scrollTop ?? 0, window.scrollY);
}

/**
 * 滚到 `top`（两种布局里只有真正会滚的那一侧生效，另一侧是空操作）。
 * @why 文档这一侧写 `document.scrollingElement.scrollTop` 而不是 `window.scrollTo(0, top)`：
 *      两者在标准模式的浏览器里等价（scrollingElement 就是 `<html>`），但 jsdom **没实现**
 *      `window.scrollTo`——组件测试一跑就刷 "Not implemented: Window's scrollTo()" 噪声，
 *      那会把真正的失败信息淹掉。写属性在两边都安静且有效。
 */
export function writeScrollTop(main: HTMLElement | null, top: number): void {
  if (main !== null) main.scrollTop = top;
  document.documentElement.scrollTop = top;
}

/**
 * 还能往下滚多少（恢复位置时用它把目标值夹住——列表还没取回来时页面没那么高）。
 * @why 同样取两侧最大值：@see readScrollTop 的理由。
 */
export function maxScrollTop(main: HTMLElement | null): number {
  const inMain = main === null ? 0 : main.scrollHeight - main.clientHeight;
  const doc = document.documentElement;
  return Math.max(inMain, doc.scrollHeight - window.innerHeight);
}
