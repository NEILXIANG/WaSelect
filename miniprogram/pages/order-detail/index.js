/**
 * 职责：订单详情页薄壳——`GET /orders/{id}` → vm → 渲染；可付可续付、可取消可取消。
 *
 * @why 订单列表只能回答"付没付、多少钱"，这一页要回答的是**"这单到底走到哪了"**：
 *      时间线、运单号、地址快照、当时同意的条款版本。
 *      它是订单列表行点击的落点，也是"付完款回来确认"的落点。
 *
 * @why 取消要**模态确认**（`showModal`）：取消不可恢复，而"手滑点了一下，订单没了"
 *      是没有任何日志能说清的一类投诉。`showModal` 在 `wx-api.ts` 登记的理由
 *      正是"破坏性操作的唯一确认手段"（@see utils/wx-api.js @limitation 九）。
 *
 * @why 取消成功后**原地重取**而不是返回列表：服务端状态是权威，
 *      用户应该立刻看到这张单变成"已取消"——跳回列表会让他先看到旧状态
 *      （列表在 onShow 才刷新，中间有一个"还是待付款"的窗口）。
 *
 * @limitation 一：**没有 id 时不发请求**，直接显示"订单不存在或链接无效"——
 *              对空 id 发 `GET /orders/` 会撞上列表路由，拿到的是别人的列表形状，
 *              在详情页上渲染成一个"看起来正常"的错页面。
 * @limitation 二：**不做支付结果轮询**（与订单列表同一条 @limitation）：
 *              完成靠服务端回调，本页 onShow 重取即是用户可见的最新真值。
 * @limitation 三：运单号复制成功只改"已复制"文案，不做 toast
 *              （`wx.showToast` 刻意未登记，@see utils/wx-api.js @limitation 九）。
 *
 * @see ./index.vm.js（视图逻辑真源，17 条单测）；../../utils/wx-api.js（showModal / setClipboardData）
 */
import { detailView } from './index.vm.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径（跳转路径只在这一处出现）。 */
const PAY_PAGE = '/pages/pay/index';

Page({
  data: {
    /** vm `detailView` 的输出；null = 还没拉到（此时只显示加载/错误）。 */
    view: null,
    loading: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** 取消请求在途（ws-button 会吞掉这期间的连点）。 */
    cancelling: false,
    /** 运单号已复制（复制成功后切换文案，@see @limitation 三）。 */
    copied: false,
  },

  /** 订单 id（来自 query；不参与渲染，放 this 上）。 */
  orderId: '',
  traceId: '',

  onLoad(options) {
    this.orderId = typeof options?.id === 'string' ? options.id : '';
    this.traceId = newTraceId();
    // @see @limitation 一：空 id 不发请求
    if (this.orderId === '') this.setData({ error: '订单不存在或链接无效' });
  },

  onShow() {
    if (this.orderId !== '') void this.load();
  },

  /** 取详情。失败**清空视图**并明示错误（留旧数据 = 把旧状态当真值）。 */
  async load() {
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}`,
        traceId: this.traceId,
      });
      this.setData({ view: detailView(res), error: '', copied: false });
    } catch (e) {
      this.setData({ view: null, error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 继续支付（仅 `canPay`；不传金额，支付页自己向服务端要权威金额）。 */
  onPay() {
    wxApi.navigateTo({ url: `${PAY_PAGE}?orderId=${this.orderId}` });
  },

  /**
   * 点运单号 → 复制。
   * @param {WechatMiniprogram.TouchEvent} e `data-no` 来自 wxml
   */
  onCopyTracking(e) {
    const no = e?.currentTarget?.dataset?.no;
    if (typeof no !== 'string' || no === '') return;
    wxApi.setClipboardData({
      data: no,
      success: () => this.setData({ copied: true }),
      fail: () => this.setData({ error: '复制失败，请长按运单号手动复制' }),
    });
  },

  /** 取消订单（先模态确认，@see 文件头 @why）。 */
  onCancelTap() {
    wxApi.showModal({
      title: '取消订单',
      content: '取消后不可恢复，确定取消这张订单吗？',
      confirmText: '确定取消',
      cancelText: '再想想',
      success: (r) => {
        if (r?.confirm === true) void this.cancel();
      },
    });
  },

  /** 发取消请求；成功后**原地重取**（@see 文件头 @why）。 */
  async cancel() {
    this.setData({ cancelling: true, error: '' });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/cancel`,
        method: 'POST',
        traceId: this.traceId,
      });
      await this.load();
    } catch (e) {
      this.setData({ error: errorMessage(e) });
    } finally {
      this.setData({ cancelling: false });
    }
  },
});
