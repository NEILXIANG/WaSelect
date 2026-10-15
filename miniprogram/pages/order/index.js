/**
 * 职责：订单列表页薄壳——`GET /orders`（按状态页签过滤，M-10）→ vm → 渲染；未付款的可继续去支付。
 *
 * @why 用 `onShow` 而不是 `onLoad` 取数：从支付页返回（尤其是 copylink 在浏览器里
 *      付完再切回来）不会触发 onLoad，只看 onLoad 的表现是
 *      "明明付过了，订单列表还是显示待付款"——而支付完成本来就靠服务端回调，
 *      列表是用户能看到的**唯一真值**。
 *      ⚠️ 但"每次进屏都拉"已于体验审查 2026-10-15（P1-2）改为**按需**：
 *      无条件重取的代价是丢分页与滚动位置（@see onShow）。真值由
 *      `globalData.ordersChanged` 的一次性信号兜住——付款 / 取消 / 确认收货 / 提交售后 /
 *      建单这些"真的改了订单"的地方都会置它，进屏读到就重取。
 *
 * @limitation 一：**不做支付结果轮询**（与支付页 @limitation 一 同一条）：
 *              完成靠服务端回调落库，本页在"订单变过"时拉一次即是"最新真值"。
 *              轮询的代价是弱网下白耗电，且它给出的仍然不是权威状态。
 *              兜底是下拉刷新（M-04）：没有推送时，买家想核对就自己下拉。
 * @limitation 二：列表行的信息密度**刻意低**（单号 / 状态 / 合计；M-11 起加首件缩略图、件数、下单时间——找单用）——
 *              时间线 / 运单号 / 地址快照 / 条款版本在详情页（U-H3，`pages/order-detail`），
 *              列表点卡片即达。往列表行里再塞这些，等于把详情页在每张卡片上重复一遍。
 *
 * @limitation 三：下拉刷新（M-04）与 onShow 共用 `load()`，**不做在途去重**——两次几乎同时的取数
 *              以后到的为准；列表是只读的，多取一次的代价只是一次请求。
 *
 * @limitation 四：状态页签（M-10，AJ-408）。「我的」四入口要落到指定页签，但本页是 tab 页，
 *              `switchTab` **不能带 query**——所以意图走 `app.globalData.orderTab`（一次性：onShow 读走即清空，
 *              同 `pickedAddressId` 的交接口径，app.js）。没有意图时保留本页上次的页签（tab 页实例常驻）。
 * @limitation 五：切页签连发请求时用请求序号（utils/request-seq.js）丢弃过期响应——
 *              先点「全部」再点「采购中」，慢回来的「全部」不许盖住「采购中」。
 *
 * @see ./index.vm.js（状态词表、列表行、页签视图）；../../utils/order-tabs.js（页签 ↔ 状态）
 */
import { emptyState, hasMoreOrders, mergeOrderRows, orderRows, tabsView } from './index.vm.js';
import { orderListQuery, resolveOrderTab, tabItems } from '../../utils/order-tabs.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { serverNowMs } from '../../utils/server-clock.js';
import { markImageFailed } from '../../utils/image-failed.js';
import { contactFields, errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';
import { track } from '../../utils/beacon.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径（跳转路径只在这一处出现）。 */
const PAY_PAGE = '/pages/pay/index';

/** 订单详情页路径（同上）。 */
const DETAIL_PAGE = '/pages/order-detail/index';
/** 首页（tab 页，剩余清单 4-8 空态出口）。 */
const HOME_PAGE = '/pages/home/index';
/** 「我的」（tab 页）：客服联系方式在那里（AJ-433）。 */
const USER_PAGE = '/pages/user/index';

Page({
  data: {
    /** vm `orderRows` 的输出。 */
    rows: [],
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** AJ-433：错误态按钮去客服（账号被拉黑）而不是重试。 */
    errorContact: false,
    /** 空态开关（**请求失败时不亮**，@see index.vm.js 的 emptyState）。 */
    empty: false,
    /** 空态文案（分页签，M-10）。 */
    emptyText: '还没有订单',
    /** 当前页签 key（M-10，utils/order-tabs.js）。 */
    activeTab: 'all',
    /** vm `tabsView` 的输出。 */
    tabs: tabsView('all'),
    /** S-7：还有下一页（vm `hasMoreOrders`）。 */
    hasMore: false,
    /** S-7：触底加载在途（页脚"加载中…"）。 */
    loadingMore: false,
    /** S-7：触底加载失败的文案（空串 = 无；页脚给"点此重试"，不动已加载的行）。 */
    moreError: '',
    /**
     * 审计 UX-004：第几行的首件缩略图加载失败（下标与 `rows` 对齐；`utils/image-failed.js`）。
     * @why 整页重取（`load`）时跟着清回空——那是一份**新的行**；
     *      触底追加（`loadMore`）**不清**：已加载的行下标没动，清了会把它们的坏图又放出来再破一次。
     */
    imgFailed: [],
  },

  traceId: '',
  /** 请求序号（@see @limitation 五；不进 data：渲染不需要它）。只有 load（新一代列表）领号，loadMore 借号。 */
  seq: 0,
  /** S-7：已加载到第几页。 */
  page: 0,
  /** S-7：已从服务端取走的条数（服务端偏移，判断还有没有下一页用；不是去重后的行数）。 */
  loaded: 0,
  /** S-7：响应里的 total。 */
  total: 0,
  /** S-7：触底加载在途标志（滚动事件没有按钮可挂 ws-button 的连点防线，只能用标志位挡）。 */
  loadingMorePage: false,
  /**
   * S-7：整页重取（新一代列表）在途。此时 loaded / total 还是上一代的，触底翻页会把旧页签的下一页
   * 用新一代的序号取回来、追加进新页签——所以重取在途时不翻页（同首页 `reloading`）。
   */
  reloadingList: false,

  onLoad() {
    this.traceId = newTraceId();
  },

  /**
   * 进屏：只更新 tabBar 与角标，**按需**才重取（体验审查 2026-10-15，P1-2）。
   * @why 原先这里无条件 `load()`：翻到第 3 页 → 点进详情 → 返回，列表只剩第 1 页 20 条、
   *      滚动位置归零（买家查"发货了没"的本能动作就是回列表，这条路径每次都被打断；
   *      订单攒多了永远翻不到底）。换页签清列表是合理的（筛选条件真变了），
   *      从详情返回**不算**换筛选条件。
   * @why 但"不重取"不能变成"显示过期状态"——所以取不取看**有没有变化**：
   *      ① 有一次性页签意图（@limitation 四）；② 别处改过订单（`globalData.ordersChanged`，
   *      取消 / 确认收货 / 提交售后 / 付款 / 建单，读走即清）；③ 从没成功取过（`page === 0`，
   *      覆盖首屏与上次失败）。三条都不成立就只更新角标，不动列表。
   * @why 下拉刷新（M-04）与点页签**仍然无条件重取**：那是用户明确要刷新，回第 1 页正是他要的。
   */
  onShow() {
    track(app, 'page_view', { page: 'order' }); // M-21 页面曝光
    // @limitation 四：「我的」四入口留下的一次性意图——读走即清空
    const intent = app.globalData.orderTab;
    let need = false;
    if (typeof intent === 'string' && intent !== '') {
      app.globalData.orderTab = '';
      this.setTab(resolveOrderTab(intent));
      need = true;
    }
    // 一次性"订单变过了"信号（@see app.js globalData.ordersChanged）：读走即清
    if (app.globalData.ordersChanged === true) {
      app.globalData.ordersChanged = false;
      need = true;
    }
    // 从没成功取过：首屏，或上次取失败（失败时 load 的 catch 把游标复位）——下次进屏要能自己恢复
    if (this.page === 0) need = true;
    if (need) void this.load();
    // S5：注入底部 tabBar 的高亮（本页是第 2 个 tab）。
    setActiveTab(this, 'order');
    // M-14（AJ-406）：购物车角标（每个 tab 页进屏都更新，utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
  },

  /** 切到某个页签（只改视图状态，不取数）。 */
  setTab(key) {
    const activeTab = resolveOrderTab(key);
    // 审计 UX-05：换了页签就先清掉上一个页签的单（加载块只在列表为空时出现，旧页签的单不能冒充新页签）
    const changed = activeTab !== this.data.activeTab;
    // 清行就一起清失败标记：下标是对着 `rows` 的，行没了标记还留着会套到新页签的行上
    this.setData({
      activeTab,
      tabs: tabsView(activeTab),
      ...(changed ? { rows: [], imgFailed: [] } : {}),
    });
  },

  /**
   * 取订单列表（按当前页签过滤）。失败**清空列表**并明示错误（留旧数据 = 显示已取消的订单还待付款）。
   * @why 过期响应直接丢（@limitation 五），连 loading 也不动——收尾归最新那次请求。
   */
  async load() {
    this.seq = nextSeq(this.seq);
    const seq = this.seq;
    const tab = this.data.activeTab;
    // 新一代列表：上一代在途的"下一页"从此过期，它的标志位由这里复位（同首页 reload / loadMore 的规则）
    this.loadingMorePage = false;
    this.reloadingList = true;
    this.setData({ loading: true, loadingMore: false, moreError: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders${orderListQuery(tab, 1)}`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.seq)) return;
      const rows = this.toRows(tab, res);
      this.page = 1;
      this.loaded = Array.isArray(res?.items) ? res.items.length : 0;
      this.total = res?.total;
      const empty = emptyState(rows, '', tab);
      this.setData({
        rows,
        imgFailed: [],
        hasMore: hasMoreOrders(this.loaded, this.total),
        error: '',
        errorContact: false,
        empty: empty.showEmpty,
        emptyText: empty.text,
      });
    } catch (e) {
      if (isStale(seq, this.seq)) return;
      // 取失败 → 分页游标三个一起复位（@see onShow 判据③）。
      // @why 列表刚被清空，游标却还说"已加载到第 1 页"：这个自相矛盾的状态会让三条判据
      //      全部落空——**首次成功之后**再失败（比如翻到第 2 页后下拉刷新网络断了），
      //      切走 tab 再切回来就再也不重取，列表永久停在这个错误态，只能杀掉小程序。
      //      不复位的话，只有"从没成功过"那一条路能自愈，而那恰恰是失败最少的路径。
      // @why 不另立"上次失败了"标志位：那是给同一件事两份状态，漏清一处就原样复发；
      //      游标复位后它自己就是那个标志——页上是空的，游标就该是 0。
      this.page = 0;
      this.loaded = 0;
      this.total = 0;
      this.setData({
        rows: [],
        imgFailed: [],
        hasMore: false,
        ...errorFields(e),
        ...contactFields(e),
        empty: false,
      });
    } finally {
      if (!isStale(seq, this.seq)) {
        this.reloadingList = false;
        this.setData({ loading: false });
      }
    }
  },

  /**
   * 响应 → 列表行。
   * @why 「售后·退款」仍过一遍 tabItems：服务端已按 include_after_sale 筛过（S-7），这里只是同一口径的防御，
   *      服务端将来口径变了也不会把无关的单显示进这个页签。
   * @why MP-14：截止已到的待付款行不给「继续支付」（时刻经服务端 Date 头校准，MP-8）。
   */
  toRows(tab, res) {
    return orderRows(
      tabItems(tab, res?.items),
      serverNowMs(Date.now(), app.globalData.clockSkewMs),
    );
  },

  /**
   * 触底追加下一页（S-7）。借当前号不领新号：切页签 / 下拉刷新（load 换号）后，在途的这一页自动作废，
   * 不会把上一个页签的第 2 页追加到新页签里。
   */
  async loadMore() {
    if (this.loadingMorePage || this.reloadingList) return;
    if (!hasMoreOrders(this.loaded, this.total)) return;
    const seq = this.seq;
    const tab = this.data.activeTab;
    const next = this.page + 1;
    this.loadingMorePage = true;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders${orderListQuery(tab, next)}`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.seq)) return;
      this.page = next;
      this.loaded += Array.isArray(res?.items) ? res.items.length : 0;
      this.total = res?.total;
      this.setData({
        rows: mergeOrderRows(this.data.rows, this.toRows(tab, res), false),
        hasMore: hasMoreOrders(this.loaded, this.total),
      });
    } catch (e) {
      if (isStale(seq, this.seq)) return;
      // 追加失败**不清列表**（已加载的行还在），只在页脚给"点此重试"——整块报错的"重试"会从第 1 页重来
      this.setData({ ...errorFields(e, 'moreError') });
    } finally {
      if (!isStale(seq, this.seq)) {
        this.loadingMorePage = false;
        this.setData({ loadingMore: false });
      }
    }
  },

  /** 触底（S-7）。 */
  async onReachBottom() {
    await this.loadMore();
  },

  /** 页脚"加载失败，点此重试"（S-7）：重取的仍是下一页，不从第 1 页重来。 */
  async onMoreRetry() {
    await this.loadMore();
  },

  /**
   * 点页签（M-10）。点当前页签也重取一次（等同于"刷新这一栏"，不另做判断）。
   * @param {WechatMiniprogram.TouchEvent} e `data-key` 来自 wxml
   */
  async onTabTap(e) {
    const key = e?.currentTarget?.dataset?.key;
    if (typeof key !== 'string') return;
    this.setTab(key);
    await this.load();
  },

  /**
   * 某一行的首件缩略图加载失败（审计 UX-004）→ 只收起那一行，不留破图。
   * @param {WechatMiniprogram.CustomEvent} e `data-index` 来自 wxml
   */
  onImgError(e) {
    const next = markImageFailed(this.data.imgFailed, e?.currentTarget?.dataset?.index);
    if (next !== null) this.setData({ imgFailed: next });
  },

  /**
   * 点卡片 → 详情。
   * @param {WechatMiniprogram.TouchEvent} e `data-id` 来自 wxml
   * @why 详情页是"这单到底走到哪了"的唯一去处（时间线 / 运单号 / 条款版本）；
   *      列表行的信息密度刻意低（@see ./index.vm.js @limitation 二）。
   */
  onRowTap(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    // 独立审查 2026-10-13 【7】：与其余 8 处跳转同口径（当前 id 是 uuid 形，编码只是防形态变化时静默传错）
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(id)}` });
  },

  /**
   * 继续支付（仅 `canPay` 的行）。
   * @why 不传金额：支付页自己向服务端要权威金额（跨页传金额 = 可被篡改）。
   */
  onPay(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    wxApi.navigateTo({ url: `${PAY_PAGE}?orderId=${encodeURIComponent(id)}` });
  },

  /**
   * 下拉刷新（M-04，AJ-405）：重取列表，**取完**再收起动画（成功失败都收）。
   * @why 没有推送时，买家查"发货了没"的本能动作就是下拉（对标分析 §3.7）；onShow 只在切回本页时刷新。
   * @why `load()` 自己吞掉错误并落到 `error`，所以这里 await 完一定走得到 stop——失败路径不会一直转圈。
   */
  async onPullDownRefresh() {
    await this.load();
    wxApi.stopPullDownRefresh();
  },

  /**
   * 错误态的按钮（P2-38）：重新取列表；账号被拉黑（errorContact，AJ-433）时去「我的」找客服——重试永远不会成功。
   */
  onRetry() {
    if (this.data.errorContact === true) {
      wxApi.switchTab({ url: USER_PAGE });
      return;
    }
    void this.load();
  },

  /** 空态"去逛逛"（剩余清单 4-8）：首页是 tab 页，只能 switchTab。 */
  onGoShopping() {
    wxApi.switchTab({ url: HOME_PAGE });
  },
});
