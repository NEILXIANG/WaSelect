/**
 * 职责：订单列表页薄壳——`GET /orders` → vm → 渲染；未付款的可继续去支付。
 *
 * @why 用 `onShow` 而不是 `onLoad` 取数：从支付页返回（尤其是 copylink 在浏览器里
 *      付完再切回来）不会触发 onLoad，只看 onLoad 的表现是
 *      "明明付过了，订单列表还是显示待付款"——而支付完成本来就靠服务端回调，
 *      列表是用户能看到的**唯一真值**，必须每次进屏都刷新。
 *
 * @limitation 一：**不做支付结果轮询**（与支付页 @limitation 一 同一条）：
 *              完成靠服务端回调落库，本页每次进屏拉一次即是"最新真值"。
 *              轮询的代价是弱网下白耗电，且它给出的仍然不是权威状态。
 * @limitation 二：列表行的信息密度**刻意低**（单号 / 状态 / 合计）——
 *              时间线 / 运单号 / 地址快照 / 条款版本在详情页（U-H3，`pages/order-detail`），
 *              列表点卡片即达。往列表行里再塞这些，等于把详情页在每张卡片上重复一遍。
 *
 * @limitation 三：下拉刷新（M-04）与 onShow 共用 `load()`，**不做在途去重**——两次几乎同时的取数
 *              以后到的为准；列表是只读的，多取一次的代价只是一次请求。
 *
 * @see ./index.vm.js（状态词表与列表行，9 条单测）
 */
import { emptyState, orderRows } from './index.vm.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径（跳转路径只在这一处出现）。 */
const PAY_PAGE = '/pages/pay/index';

/** 订单详情页路径（同上）。 */
const DETAIL_PAGE = '/pages/order-detail/index';
/** 首页（tab 页，剩余清单 4-8 空态出口）。 */
const HOME_PAGE = '/pages/home/index';

Page({
  data: {
    /** vm `orderRows` 的输出。 */
    rows: [],
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** 空态开关（**请求失败时不亮**，@see index.vm.js 的 emptyState）。 */
    empty: false,
  },

  traceId: '',

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    void this.load();
    // S5：注入底部 tabBar 的高亮（本页是第 2 个 tab）。
    setActiveTab(this, 'order');
    // M-14（AJ-406）：购物车角标（每个 tab 页进屏都更新，utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
  },

  /** 取订单列表。失败**清空列表**并明示错误（留旧数据 = 显示已取消的订单还待付款）。 */
  async load() {
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders`,
        traceId: this.traceId,
      });
      const rows = orderRows(res?.items);
      this.setData({ rows, error: '', empty: emptyState(rows, '').showEmpty });
    } catch (e) {
      this.setData({ rows: [], ...errorFields(e), empty: false });
    } finally {
      this.setData({ loading: false });
    }
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

  /** 错误态的"重试"（P2-38）：重新取列表。 */
  onRetry() {
    void this.load();
  },

  /** 空态"去逛逛"（剩余清单 4-8）：首页是 tab 页，只能 switchTab。 */
  onGoShopping() {
    wxApi.switchTab({ url: HOME_PAGE });
  },
});
