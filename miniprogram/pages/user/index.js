/**
 * 职责：「我的」页薄壳——登录态 + 三个入口，按下就跳。
 *
 * @why 本页是订单 / 地址 / 法务三个页**唯一的入口**：它们此前在 `app.json` 里注册了、
 *      也能跑，但从首页出发没有任何路径能走到（付完款回到首页，订单就找不到了）。
 *      所以"薄"不是偷懒——它要做的事就是把那三个页挂回可达图上。
 *
 * @why 跳转按 `key` 查表（`PAGE_BY_KEY`）而不是在 wxml 里写三个 `bindtap` 各自跳：
 *      三个 handler 各写一遍路径的话，"加一个入口忘了接跳转"不会报错，
 *      表现只是"点了没反应"。查表之后**缺一项就是 undefined，直接不跳**——
 *      而且 vm 的单测会断言每个 key 都在本表里（@see index.vm.unit.test.ts）。
 *
 * @limitation 一：**不预检登录**。订单 / 地址接口是受保护的，未登录时首个请求会
 *              40101 → relogin 自动重放（`utils/request.js` @limitation 一），
 *              所以这里挡一道是多余的，且会挡住"登录正在进行中"这一段时间。
 * @limitation 二：`onShow` 而不是 `onLoad` 读 token：token 可能在别的页面被 relogin 刷新，
 *              只看 onLoad 的表现是"登录成功了，我的页还显示正在登录"。
 *
 * @see ./index.vm.js（登录态文案与入口清单，5 条单测）；../../utils/wx-api.js（navigateTo）
 */
import { MENU_ROWS, loginRetryView, loginState } from './index.vm.js';
import { createWxApi } from '../../utils/wx-api.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';
import { supportRows } from '../../utils/support.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 入口 key → 页面路径。**跳转路径只在这一处出现**。 */
const PAGE_BY_KEY = {
  orders: '/pages/order/index',
  address: '/pages/address/index',
  legal: '/pages/legal/index',
};

/**
 * S5 之后**已经是 tab 页**的入口：它们必须走 `switchTab`，`navigateTo` 会被宿主拒绝。
 *
 * @why 单独一张表而不是"看路径猜"：判断"这是不是 tab 页"的唯一真源是
 *      `app.json` 的 `tabBar.list`，而这里不能读 app.json（运行时拿不到）。
 *      于是这是一份**手写副本**——用一张显式的、带注释的表，
 *      比在每个入口旁各写一个 if 更容易在加 tab 时被看见。
 *      ⚠️ 漏登记的表现是"点了没反应"（宿主拒绝 navigateTo），且只在真机出现。
 */
const TAB_KEYS = new Set(['orders']);

Page({
  data: {
    /** 入口清单（vm `MENU_ROWS`）。 */
    rows: MENU_ROWS,
    /** vm `loginState` 的输出。 */
    login: { logged: false, text: '正在登录…' },
    /** M-17（AJ-406）：vm `loginRetryView` 的输出（启动登录失败时的"重新登录"按钮）。 */
    retry: { show: false, text: '', disabled: true, note: '' },
    /** 剩余清单 4-2：客服联系方式（utils/support.js）；空数组 = 客服未配置，不显示整张卡。 */
    support: [],
    /** 刚复制的是哪一行（'' = 没有）。 */
    supportCopied: '',
  },

  onShow() {
    // @see @limitation 二：token 可能在别处被刷新，每次进屏重读
    this.retryFailed = false;
    this.renderLogin();
    // S5：注入底部 tabBar 的高亮（本页是第 3 个 tab）。
    setActiveTab(this, 'user');
    // M-14（AJ-406）：购物车角标（每个 tab 页进屏都更新，utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
    void this.loadSupport();
  },

  /** 本页重试在途（M-17；不进 data：渲染态由 `retry` 表达）。 */
  retrying: false,
  /** 上一次本页重试失败了（M-17）。 */
  retryFailed: false,

  /** 登录态 + 重试按钮（同一次读 globalData，两者不会各说各的）。 */
  renderLogin() {
    const login = loginState(app.globalData.token, app.globalData.loginFailed);
    const retry = loginRetryView({
      logged: login.logged,
      failed: app.globalData.loginFailed,
      retrying: this.retrying,
      available: typeof app.globalData.retryLogin === 'function',
      retryFailed: this.retryFailed,
    });
    this.setData({ login, retry });
  },

  /**
   * 「重新登录」（M-17，AJ-406）：调 app 的 `retryLogin`（与启动自动登录同一跳，utils/auth-session.js loginAndStore）。
   * @why 在途时直接 return：按钮虽已禁用，但视图层回传有延迟（与结算页 W-03 同一类），双击会穿透。
   */
  async onRetryLogin() {
    if (this.retrying) return;
    const retryLogin = app.globalData.retryLogin;
    if (typeof retryLogin !== 'function') return;
    this.retrying = true;
    this.renderLogin();
    let ok = false;
    try {
      ok = (await retryLogin())?.ok === true;
    } finally {
      this.retrying = false;
      this.retryFailed = !ok;
      this.renderLogin();
    }
  },

  /**
   * 拉客服联系方式（剩余清单 4-2）。
   * @why 失败**静默**（只是不显示客服卡）：这是一张辅助卡，为它在「我的」页顶一个错误条不值得；
   *      而失败时显示旧值也无妨——联系方式不是会过期的数据。
   */
  async loadSupport() {
    try {
      const res = await app.globalData.api({ url: `${app.globalData.apiBase}/api/v1/support` });
      this.setData({ support: supportRows(res) });
    } catch {
      // 静默：见上
    }
  },

  /** 点客服一行 → 复制（微信号 / 邮箱）。 */
  onCopySupport(e) {
    const key = e?.currentTarget?.dataset?.key;
    const value = e?.currentTarget?.dataset?.value;
    if (typeof value !== 'string' || value === '') return;
    wxApi.setClipboardData({
      data: value,
      success: () => this.setData({ supportCopied: typeof key === 'string' ? key : '' }),
    });
  },

  /**
   * 点入口。
   * @param {WechatMiniprogram.TouchEvent} e `data-key` 来自 wxml
   * @why 查不到路径**直接 return** 而不是兜底跳首页：
   *      静默跳到一个不相干的页面，比"点了没反应"更难排查（用户不知道自己被带去了哪）。
   */
  onMenuTap(e) {
    const key = e?.currentTarget?.dataset?.key;
    const url = typeof key === 'string' ? PAGE_BY_KEY[key] : undefined;
    // ⚠️ 只认字符串：`PAGE_BY_KEY['constructor']` 拿到的是原型上的函数，不是路径
    if (typeof url !== 'string') return;
    // S5：tab 页走 switchTab，其余走 navigateTo（用 navigateTo 跳 tab 页会被宿主拒绝）
    if (typeof key === 'string' && TAB_KEYS.has(key)) {
      wxApi.switchTab({ url });
      return;
    }
    wxApi.navigateTo({ url });
  },
});
