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
 *              ⚠️ 唯一的例外是 MP3-04 的确认窗口：从支付页带 `justPaid=1` 过来时，
 *              最多**退避重查两次**（见 scheduleRecheck）——那是"钱已动、只等确认"的几秒，
 *              且两次之后一定放弃假设、把按钮还给用户，不是常规轮询。
 * @limitation 三：运单号复制成功只改"已复制"文案，不做 toast
 *              （`wx.showToast` 刻意未登记，@see utils/wx-api.js @limitation 九）。
 *
 * @see ./index.vm.js（视图逻辑真源，17 条单测）；../../utils/wx-api.js（showModal / setClipboardData）
 */
import { detailView } from './index.vm.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { recentExternalPay } from '../../utils/external-pay.js';

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
    /** 刚复制的是哪一个：'no' 运单号 / 'url' 查件链接 / '' 都没有（两行各自显示「已复制」）。 */
    copied: '',
  },

  /** 订单 id（来自 query；不参与渲染，放 this 上）。 */
  orderId: '',
  traceId: '',

  /**
   * 「刚刚付过款，服务端还没确认」（MP3-04，P1）。
   * @why 它由**支付页**带过来（`?justPaid=1`），因为"谁刚付过"只有支付页知道——
   *      从订单数据里推不出来（那一刻服务端眼里就是一张普通的待付款单）。
   * @limitation 是一次性假设：复核两次后放弃（见 scheduleRecheck）。
   */
  justPaid: false,
  /** 已复核次数（上限 2，见 scheduleRecheck 的 @why）。 */
  recheckCount: 0,
  /** 复核定时器（onUnload 必清，否则页面销毁后还在 setData）。 */
  recheckTimer: null,
  /** 最近一次拿到的订单原文（放弃 justPaid 假设后要按它重渲染）。 */
  lastOrder: null,

  onLoad(options) {
    this.orderId = typeof options?.id === 'string' ? options.id : '';
    this.traceId = newTraceId();
    // 刚从支付页过来（微信支付成功带 justPaid=1），或这张单刚在浏览器里发起过银行卡付款（W-02）：
    // 两种情况支付通知都可能还没到，先显示"确认中"、退避重查，而不是给出"继续支付 / 取消订单"。
    this.justPaid =
      options?.justPaid === '1' ||
      recentExternalPay(app.globalData.externalPay, this.orderId, Date.now());
    this.recheckCount = 0;
    // @see @limitation 一：空 id 不发请求
    if (this.orderId === '') this.setData({ error: '订单不存在或链接无效' });
  },

  onUnload() {
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
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
      this.lastOrder = res;
      this.setData({
        view: detailView(res, { justPaid: this.justPaid }),
        error: '',
        copied: '',
      });
      this.scheduleRecheck();
    } catch (e) {
      this.setData({ view: null, error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 「支付结果确认中」时退避重查（MP3-04）。
   *
   * @why 只在这一种状态下重查：这是"钱已经动了、只等服务端确认"的窗口，
   *      轮询几次就能拿到真值；而常规状态不需要（onShow 重取已足够，@see @limitation 二）。
   * @why **上限两次**然后放弃假设：justPaid 是支付页给的**假设**，它可能为假
   *      （用户在托管页关掉了页面、付款其实没成）。假设为真时两次足够确认；
   *      假设为假时必须把按钮还给用户——不能让人永久停在一个什么都点不了的屏幕上。
   * @limitation 退避是固定 1.5s / 3s，不是指数：窗口只有几秒，再长的等待没有意义，
   *              而页面销毁时定时器必清（onUnload），不会泄漏。
   */
  scheduleRecheck() {
    const view = this.data.view;
    if (view === null || view.needsRecheck !== true) return;
    if (this.recheckCount >= 2) {
      // 两次都没确认下来 → 放弃"刚付过"这个假设，恢复常规按钮
      this.justPaid = false;
      this.setData({ view: detailView(this.lastOrder, { justPaid: false }) });
      return;
    }
    this.recheckCount += 1;
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => void this.load(), 1500 * this.recheckCount);
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
    const kind = e?.currentTarget?.dataset?.kind === 'url' ? 'url' : 'no';
    if (typeof no !== 'string' || no === '') return;
    wxApi.setClipboardData({
      data: no,
      success: () => this.setData({ copied: kind }),
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
