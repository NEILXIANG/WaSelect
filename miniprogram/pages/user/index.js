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
 * @limitation 三：四个订单入口（M-10 附，AJ-408）要落到订单页的指定页签，而订单页是 tab 页、`switchTab` 不能带 query，
 *              所以写一次性意图 `app.globalData.orderTab`（订单页 onShow 读走即清空）。「我的订单」一行写 'all'。
 *              角标来自进屏时一次不带过滤的 `GET /orders`（失败静默，只是不显示角标）。
 *
 * @see ./index.vm.js（登录态文案与入口清单，5 条单测）；../../utils/wx-api.js（navigateTo）
 */
import { MENU_ROWS, ORDERS_ENTRY, loginRetryView, loginState, orderShortcuts } from './index.vm.js';
import { ORDER_TABS } from '../../utils/order-tabs.js';
import { createWxApi } from '../../utils/wx-api.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';
import { supportRows } from '../../utils/support.js';
import { track } from '../../utils/beacon.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 入口 key → 页面路径。**跳转路径只在这一处出现**（订单页另有 ORDER_PAGE，见下）。 */
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

/**
 * 订单页（tab 页）——四个订单入口（M-10 附，AJ-408）的跳转目标。
 * @why 与 `PAGE_BY_KEY.orders` 同值却单列：tab-nav-guard 只能静态解析"字面量 / 常量名"形式的 url
 *      （`PAGE_BY_KEY.orders` 这种成员访问它解析不了，会被当成未登记的动态路径而红）；
 *      `PAGE_BY_KEY` 的表形又被 vm 单测按字面量扫描。两处同值由 shell 单测守着（两种入口都断言跳 `/pages/order/index`）。
 */
const ORDER_PAGE = '/pages/order/index';

Page({
  data: {
    /** 入口清单（vm `MENU_ROWS`）。 */
    rows: MENU_ROWS,
    /** 订单卡片标题行（vm `ORDERS_ENTRY`），点它走 onMenuTap。 */
    ordersEntry: ORDERS_ENTRY,
    /** vm `loginState` 的输出。 */
    login: { logged: false, text: '正在登录…' },
    /** M-17（AJ-406）：vm `loginRetryView` 的输出（启动登录失败时的"重新登录"按钮）。 */
    retry: { show: false, text: '', disabled: true, note: '' },
    /** 剩余清单 4-2：客服联系方式（utils/support.js）；空数组 = 客服未配置，不显示整张卡。 */
    support: [],
    /** 体验排查 2026-10-14：客服接口已回来（可能为空）——空时显示「暂未设置」，别让从别页点「联系客服」过来的人扑空 */
    supportLoaded: false,
    /** 刚复制的是哪一行（'' = 没有）。 */
    supportCopied: '',
    /** M-10 附（AJ-408）：四个订单入口（vm `orderShortcuts`；取到订单前无角标）。 */
    shortcuts: orderShortcuts(undefined),
  },

  onShow() {
    track(app, 'page_view', { page: 'user' }); // M-21 页面曝光
    // @see @limitation 二：token 可能在别处被刷新，每次进屏重读
    this.retryFailed = false;
    this.renderLogin();
    this.watchLogin();
    // S5：注入底部 tabBar 的高亮（本页是第 3 个 tab）。
    setActiveTab(this, 'user');
    // M-14（AJ-406）：购物车角标（每个 tab 页进屏都更新，utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
    void this.loadSupport();
    void this.loadOrderBadges();
  },

  /**
   * 下拉刷新（第 24 项，2026-10-10）：重取客服信息与订单角标，**两条都回来**才收起动画。
   * @why 两者原先只在进屏时取：停在本页时（如从支付页 redirect 回来前后）角标不会自己更新。
   *      两个取数都吞错误（静默），所以 await 完一定走得到 stop。
   */
  async onPullDownRefresh() {
    await Promise.all([this.loadSupport(), this.loadOrderBadges()]);
    wxApi.stopPullDownRefresh();
  },

  /**
   * 四入口角标（M-10 附）：`GET /orders/counts` 服务端计数（S-7，vm orderShortcuts @why）。
   * @why 失败**静默**（同 loadSupport）：角标是辅助信息，入口本身照常可点。
   */
  async loadOrderBadges() {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/counts`,
      });
      this.setData({ shortcuts: orderShortcuts(res) });
    } catch {
      this.setData({ shortcuts: orderShortcuts(undefined) });
    }
    // 这次请求可能触发了 40101 静默重登：登录态以请求之后的 globalData 为准（审查 2026-10-09）
    this.renderLogin();
  },

  /**
   * 点订单入口（M-10 附）→ 写一次性页签意图 + 切到订单 tab。
   * @why 只认 `ORDER_TABS` 里的 key（`find`，不走对象下标——原型键不算）；认不出直接 return（同 onMenuTap）。
   */
  onShortcutTap(e) {
    const key = e?.currentTarget?.dataset?.key;
    if (typeof key !== 'string' || !ORDER_TABS.some((t) => t.key === key)) return;
    app.globalData.orderTab = key;
    wxApi.switchTab({ url: ORDER_PAGE });
  },

  /** 等启动登录落定的定时器（审查 2026-10-09）。 */
  loginWatchTimer: null,

  /**
   * 启动自动登录还在途时，每 500ms 看一眼，落定（拿到 token 或失败）就重画一次并停表（审查 2026-10-09）。
   * @why 此前登录态只在 onShow / 点重试时画：刚启动就进「我的」，要切走再回来才从"正在登录…"变过来。
   * @why 用短轮询而不是在 app.js 里加订阅：app.js 是装配层、不可测；而"读 globalData 判断落没落定"
   *      本来就是 renderLogin 的口径，轮询只是让它多跑几次。最多 60 次（30 秒）后停，不常驻。
   * @limitation 小程序页面全局白名单只有 setTimeout（见 pay 页 startCountdown），所以是链式 setTimeout。
   */
  watchLogin() {
    this.stopWatchLogin();
    let left = 60;
    const tick = () => {
      this.loginWatchTimer = null;
      const settled = app.globalData.token !== '' || app.globalData.loginFailed === true;
      if (settled) {
        this.renderLogin();
        return;
      }
      left -= 1;
      if (left > 0) this.loginWatchTimer = setTimeout(tick, 500);
    };
    const settledNow = app.globalData.token !== '' || app.globalData.loginFailed === true;
    if (!settledNow) this.loginWatchTimer = setTimeout(tick, 500);
  },

  stopWatchLogin() {
    if (this.loginWatchTimer !== null) clearTimeout(this.loginWatchTimer);
    this.loginWatchTimer = null;
  },

  onHide() {
    this.stopWatchLogin();
  },

  onUnload() {
    this.stopWatchLogin();
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
      this.setData({ support: supportRows(res), supportLoaded: true });
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
      // M-10 附：「我的订单」= 全部页签（否则订单页会停在上次从四入口进的那一栏）
      if (key === 'orders') app.globalData.orderTab = 'all';
      wxApi.switchTab({ url });
      return;
    }
    wxApi.navigateTo({ url });
  },
});
