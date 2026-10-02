/**
 * 职责：底部 tab 的**序号真源**与"注入高亮"的唯一实现（S5）。
 *
 * @why S5 之后"哪个 tab 是第几个"有**三处**表达，而且三处都必须同步：
 *      ① `app.json` 的 `tabBar.list`（宿主读它决定哪些页是 tab 页）；
 *      ② `custom-tab-bar/index.js` 的 `data.list`（组件读它渲染四个格子）；
 *      ③ 本文件的 `TAB_INDEX`（四个 tab 页在 `onShow` 里读它注入 `active`）。
 *      三处漂移的表现是**"人在购物车、高亮却在首页"**——不报错、不崩溃，
 *      而且只有在真机上点一遍才看得出来（没有任何测试天然覆盖它）。
 *      所以：①②由 `custom-tab-bar/index.unit.test.ts` 断言一致；
 *          ③与①由同一处断言（序号即数组下标）。
 *
 * @why `active` 要**页面注入**而不是组件自己推导：
 *      组件能拿到 `getCurrentPages()`，但那等于在组件里放第四份"路径 → 序号"映射。
 *      少一份映射就是少一处漂移（@see custom-tab-bar/index.js @limitation 一）。
 *
 * @limitation 一：`setActiveTab` **静默跳过**取不到 tabBar 实例的情形。
 *              @why 取不到是**合法的**：① 该页不是 tab 页（本文件只应被 tab 页调用，
 *                  但调用错了也不该白屏）；② 开发者工具上 `getTabBar()` 在某些
 *                  基础库/场景（如页面首次 attach 前）返回 null。
 *                  这里抛错的代价（白屏）远大于"高亮晚一帧"。
 * @limitation 二：只设 `active`，**不改 tabBar 的其它状态**（如购物车角标）。
 *              角标一旦进来，"谁负责更新它"就有两个答案，而两个答案都会漏更新。
 *              真要角标时，在组件里加一个属性 + 一个明确的更新方，不要从这里顺手 setData。
 *
 * @see ../custom-tab-bar/index.js；../app.json
 */
/**
 * tab 名 → 序号。**顺序即 `app.json` 的 `tabBar.list` 的下标**。
 * @warning 改顺序必须同时改那两处，否则高亮会错位（见文件头 @why）。
 */
export const TAB_INDEX = {
  home: 0,
  cart: 1,
  order: 2,
  user: 3,
};

/** tabBar 上格子的个数（与 `TAB_INDEX` 的键数一致；由单测断言）。 */
export const TAB_COUNT = Object.keys(TAB_INDEX).length;

/**
 * 把当前 tab 的序号注入 tabBar（**每个 tab 页的 `onShow` 都要调一次**）。
 *
 * @param {unknown} page 页面实例（`this`）
 * @param {keyof typeof TAB_INDEX} name tab 名
 * @returns {boolean} 是否真的注入了（false = 取不到 tabBar 或 tab 名不认识；调用方无需处理）
 *
 * @why 返回值而不是 void：让"注入没生效"这件事**可被测试**，
 *      否则"忘了在 onShow 里调"只能靠真机点一遍发现（S5 三个产物缺一个就是这种错）。
 */
export function setActiveTab(page, name) {
  const index = TAB_INDEX[name];
  if (typeof index !== 'number') return false;
  // ⚠️ `getTabBar` 在某些基础库/场景返回 null（@see @limitation 一）
  const bar = typeof page?.getTabBar === 'function' ? page.getTabBar() : null;
  if (bar === null || bar === undefined || typeof bar.setData !== 'function') return false;
  bar.setData({ active: index });
  return true;
}
