/**
 * 职责：「我的」页（`pages/user`）的**视图逻辑**——纯函数（CLAUDE.md 约束十一）。
 *
 * @why 这一页的存在理由是**可达性**：订单 / 地址 / 法务三个页此前**没有任何入口**——
 *      它们在 `app.json` 里注册了、页面也能跑，但用户从首页出发永远走不到。
 *      "主链路已闭环"这句话此前只成立于"顺着 navigateTo 一路点下去"，
 *      而用户付完款回到首页之后，订单就再也找不到了。
 *      本页是那三个页唯一的入口，所以它**薄也得有**。
 *
 * @why 入口清单（`MENU_ROWS`）住在 vm 而不是 wxml：wxml 里三个 `<view>` 各写一遍
 *      "我的订单 / 收货地址 / 条款与政策"的话，"加一个入口忘了写跳转"
 *      不会有任何报错——表现只是"点了没反应"。
 *      住在 vm 之后，单测还能顺带断言"每个入口在 index.js 的跳转表里都有对应路径"
 *      （@see index.vm.unit.test.ts 最后一组）。
 *
 * @limitation 一：客服入口（剩余清单 4-2）由 `GET /support`（契约 0.6.33）驱动，展示逻辑在 `utils/support.js`；
 *              客服账号未配置时服务端回空对象，页面不显示——仍然**不写假的联系方式**（用户会真的去加那个微信号）。
 * @limitation 二：登录态只有"已登录 / 正在登录"两态，且**只凭本地 token 判断**。
 *              没有用户资料接口（MVP 不需要昵称头像，@see app.js @limitation 三），
 *              所以"显示给谁看"这件事目前只有这一个可信信号。
 *              ⚠️ token 存在 ≠ 服务端认它（过期 / 吊销要到真请求 40101 才知道），
 *              所以这里显示"已登录"是**本地视角**，不是服务端的权威结论。
 *
 * @see ./index.js（跳转表 `PAGE_BY_KEY`）；../../utils/wx-api.js（navigateTo）
 */
import { ORDER_TABS, orderTabCounts, tabBadgeText } from '../../utils/order-tabs.js';

/**
 * 「我的」四个订单入口（M-10 附，AJ-408）：订单页除「全部」外的四个页签，带进行中单数角标。
 *
 * @param {unknown} items 一次 `GET /orders`（不带 status）的 items；取数失败传 undefined
 * @returns {Array<{key: string, label: string, badge: string}>}
 * @why 入口直接取 `ORDER_TABS`（同一份页签定义）：入口与页签各写一份标签，改一处漏一处，
 *      表现是"点「采购中」进去高亮的是「待发货」"。
 * @why 角标由**一次**不带过滤的 `GET /orders` 在本地分组得出（`orderTabCounts`），而不是四个页签各请求一次：
 *      买家列表本就无分页、全量返回（server adapters/orders.ts listOwnedOrders @limitation），一次就有全部状态；
 *      四次请求换来的是同一份数据。代价见 @limitation。
 * @limitation 一：单量变大后「我的」每次进屏都拉全量列表——等列表接口加分页时，角标要改为服务端计数（契约变更）。
 * @limitation 二：取数失败 → 不显示角标（空串），入口照常可点；不显示"0"（0 是"确定没有"，失败时我们不确定）。
 */
export function orderShortcuts(items) {
  const counts = orderTabCounts(items);
  return ORDER_TABS.filter((t) => t.key !== 'all').map((t) => ({
    key: t.key,
    label: t.label,
    badge: Array.isArray(items) ? tabBadgeText(counts[t.key]) : '',
  }));
}

/**
 * 入口清单（顺序即展示顺序）。
 *
 * @why `key` 是**唯一**交给页面的东西：vm 不认识页面路径（与首页 `intentForProduct` 同口径），
 *      路径在 `index.js` 的 `PAGE_BY_KEY` 里按 key 查。vm 一旦认识路径，
 *      它就不再是"可在 Node 里被 import 的纯函数"了。
 */
export const MENU_ROWS = [
  { key: 'orders', label: '我的订单' },
  { key: 'address', label: '收货地址' },
  { key: 'legal', label: '条款与政策' },
];

/**
 * 本地 token → 登录态文案。
 *
 * @param {unknown} token `app.globalData.token`；也可能是任何东西
 * @param {unknown} [failed] `app.globalData.loginFailed`：启动自动登录是否已失败（W-08）
 * @returns {{logged: boolean, text: string}}
 *
 * @why 未登录时显示"正在登录…"而不是"未登录"：登录是**无感**的（code 换 token，没有登录页），
 *      真实状态是"正在自动登录"，写"未登录"会让用户去找一个不存在的登录按钮。
 *      真失败时（启动登录失败）首个受保护请求会 40101 → relogin 再试一次，
 *      用户不需要做任何事——所以这里**不需要**失败态（@see @limitation 二）。
 */
export function loginState(token, failed = false) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (t !== '') return { logged: true, text: '已登录（微信）' };
  // 启动时的自动登录已经失败（W-08）：此刻并没有在登录，再写"正在登录…"就是一句永远不会变的话
  if (failed === true) return { logged: false, text: '登录暂未成功，下次操作时会自动重试' };
  return { logged: false, text: '正在登录…' };
}

/**
 * 「重新登录」按钮的视图（M-17，AJ-406）。
 *
 * @param {{logged?: unknown, failed?: unknown, retrying?: unknown, available?: unknown, retryFailed?: unknown}|null|undefined} s
 *   `logged`      `loginState` 的 logged
 *   `failed`      `app.globalData.loginFailed`（启动登录已失败）
 *   `retrying`    本页发起的重试在途
 *   `available`   `app.globalData.retryLogin` 是否可用（没配 API 地址时为 null）
 *   `retryFailed` 上一次本页重试失败了
 * @returns {{show: boolean, text: string, disabled: boolean, note: string}}
 *
 * @why 只在"确实失败了"时给按钮：正在登录时给按钮，用户一点就是第二个在途登录
 *      （singleFlight 会合并它，但按钮本身在说"现在需要你做点什么"——那不是事实）。
 * @why 重试也失败时要说出来（note），而不是按钮恢复原样：否则用户分不清"点了没反应"与"点了但又失败"。
 * @limitation 失败原因不展示（wx.login 的 errMsg 是给开发者看的）；排障靠实时日志 `retry_login`。
 */
export function loginRetryView(s) {
  const a = s !== null && typeof s === 'object' ? s : {};
  const show = a.logged !== true && a.failed === true && a.available === true;
  if (!show) return { show: false, text: '', disabled: true, note: '' };
  if (a.retrying === true) return { show: true, text: '正在重新登录…', disabled: true, note: '' };
  return {
    show: true,
    text: '重新登录',
    disabled: false,
    note: a.retryFailed === true ? '还是没有登录成功，请检查网络后再试' : '',
  };
}
