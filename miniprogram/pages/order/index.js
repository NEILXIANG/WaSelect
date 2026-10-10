/**
 * 职责：订单列表页薄壳——`GET /orders`（按状态页签过滤，M-10）→ vm → 渲染；未付款的可继续去支付。
 *
 * @why 用 `onShow` 而不是 `onLoad` 取数：从支付页返回（尤其是 copylink 在浏览器里
 *      付完再切回来）不会触发 onLoad，只看 onLoad 的表现是
 *      "明明付过了，订单列表还是显示待付款"——而支付完成本来就靠服务端回调，
 *      列表是用户能看到的**唯一真值**，必须每次进屏都刷新。
 *
 * @limitation 一：**不做支付结果轮询**（与支付页 @limitation 一 同一条）：
 *              完成靠服务端回调落库，本页每次进屏拉一次即是"最新真值"。
 *              轮询的代价是弱网下白耗电，且它给出的仍然不是权威状态。
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
import { emptyState, orderRows, tabsView } from './index.vm.js';
import { resolveOrderTab, tabItems, tabStatusParam } from '../../utils/order-tabs.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
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
  },

  traceId: '',
  /** 请求序号（@see @limitation 五；不进 data：渲染不需要它）。 */
  seq: 0,

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    track(app, 'page_view', { page: 'order' }); // M-21 页面曝光
    // @limitation 四：「我的」四入口留下的一次性意图——读走即清空
    const intent = app.globalData.orderTab;
    if (typeof intent === 'string' && intent !== '') {
      app.globalData.orderTab = '';
      this.setTab(resolveOrderTab(intent));
    }
    void this.load();
    // S5：注入底部 tabBar 的高亮（本页是第 2 个 tab）。
    setActiveTab(this, 'order');
    // M-14（AJ-406）：购物车角标（每个 tab 页进屏都更新，utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
  },

  /** 切到某个页签（只改视图状态，不取数）。 */
  setTab(key) {
    const activeTab = resolveOrderTab(key);
    this.setData({ activeTab, tabs: tabsView(activeTab) });
  },

  /**
   * 取订单列表（按当前页签过滤）。失败**清空列表**并明示错误（留旧数据 = 显示已取消的订单还待付款）。
   * @why 过期响应直接丢（@limitation 五），连 loading 也不动——收尾归最新那次请求。
   */
  async load() {
    this.seq = nextSeq(this.seq);
    const seq = this.seq;
    const tab = this.data.activeTab;
    const status = tabStatusParam(tab);
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders${status === '' ? '' : `?status=${status}`}`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.seq)) return;
      // AJ-430：「售后·退款」取的是全量，本地只留退款中 / 已退款或有售后申请的单（其它页签原样）
      const rows = orderRows(tabItems(tab, res?.items));
      const empty = emptyState(rows, '', tab);
      this.setData({
        rows,
        error: '',
        errorContact: false,
        empty: empty.showEmpty,
        emptyText: empty.text,
      });
    } catch (e) {
      if (isStale(seq, this.seq)) return;
      this.setData({ rows: [], ...errorFields(e), ...contactFields(e), empty: false });
    } finally {
      if (!isStale(seq, this.seq)) this.setData({ loading: false });
    }
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
   * 点卡片 → 详情。
   * @param {WechatMiniprogram.TouchEvent} e `data-id` 来自 wxml
   * @why 详情页是"这单到底走到哪了"的唯一去处（时间线 / 运单号 / 条款版本）；
   *      列表行的信息密度刻意低（@see ./index.vm.js @limitation 二）。
   */
  onRowTap(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${id}` });
  },

  /**
   * 继续支付（仅 `canPay` 的行）。
   * @why 不传金额：支付页自己向服务端要权威金额（跨页传金额 = 可被篡改）。
   */
  onPay(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    wxApi.navigateTo({ url: `${PAY_PAGE}?orderId=${id}` });
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
