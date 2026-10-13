/**
 * 职责：主区滚动位置的记忆——后退 / 前进回到原处，点链接 / 侧栏进新页面从页顶开始（全入口点击测试 2026-10-11）。
 *
 * @why 实测：订单列表滚到下面点开一单，返回后回到页顶，要重新往下找；主流后台返回时停在原处。
 *      原先整个应用没有任何滚动处理：列表 → 详情碰巧回到页顶（详情先渲染空态），返回列表也因先渲染空列表被夹到 0。
 * @why "是不是点出来的"用一次性标记（`markPush`）：hash 路由下点链接与后退都只触发 hashchange，分不出来；
 *      应用内的 `navigate()` 与页面里 `#/…` 链接点击都会先打标记，没标记的换页就当后退 / 前进 / 手改地址。
 * @limitation 只记在内存里（当前页签有效，刷新即忘）；位置按完整网址（含筛选与页码）记。
 *             恢复要等列表取数撑开高度——调用方按帧重试，最多约 2 秒，取不到那么高就停在能到的最下面。
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
