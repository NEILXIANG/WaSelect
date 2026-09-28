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
 * @limitation 一：**刻意没有客服入口**（PRD「我的」P0 里有：客服微信号 / 邮箱）。
 *              契约**没有任何客服字段**，客服账号也尚未确定——
 *              现在写只能写一个假的联系方式，而用户会真的去加那个微信号。
 *              假的联系方式**比没有更贵**（没有只会让人问一句，假的会让人白等）。
 *              等运营定值 + 契约有字段后单独立单元补，不在这里占位。
 * @limitation 二：登录态只有"已登录 / 正在登录"两态，且**只凭本地 token 判断**。
 *              没有用户资料接口（MVP 不需要昵称头像，@see app.js @limitation 三），
 *              所以"显示给谁看"这件事目前只有这一个可信信号。
 *              ⚠️ token 存在 ≠ 服务端认它（过期 / 吊销要到真请求 40101 才知道），
 *              所以这里显示"已登录"是**本地视角**，不是服务端的权威结论。
 *
 * @see ./index.js（跳转表 `PAGE_BY_KEY`）；../../utils/wx-api.js（navigateTo）
 */
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
 * @returns {{logged: boolean, text: string}}
 *
 * @why 未登录时显示"正在登录…"而不是"未登录"：登录是**无感**的（code 换 token，没有登录页），
 *      真实状态是"正在自动登录"，写"未登录"会让用户去找一个不存在的登录按钮。
 *      真失败时（启动登录失败）首个受保护请求会 40101 → relogin 再试一次，
 *      用户不需要做任何事——所以这里**不需要**失败态（@see @limitation 二）。
 */
export function loginState(token) {
  const t = typeof token === 'string' ? token.trim() : '';
  return t === '' ? { logged: false, text: '正在登录…' } : { logged: true, text: '已登录（微信）' };
}
