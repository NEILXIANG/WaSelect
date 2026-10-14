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
 * @limitation 三：订单号 / 运单号复制成功只改"已复制"文案，不做 toast
 *              （`wx.showToast` 刻意未登记，@see utils/wx-api.js @limitation 九）。
 *
 * @see ./index.vm.js（视图逻辑真源，17 条单测）；../../utils/wx-api.js（showModal / setClipboardData）
 */
import {
  actionFailure,
  afterSaleBrief,
  buyAgainItems,
  detailView,
  orderNotFound,
} from './index.vm.js';
import { contactFields, errorFields } from '../../utils/error-text.js';
import { copyFailText } from '../../utils/privacy.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { recentExternalPay } from '../../utils/external-pay.js';
import { supportRows } from '../../utils/support.js';
import { track } from '../../utils/beacon.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { serverNowMs } from '../../utils/server-clock.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 支付页路径（跳转路径只在这一处出现）。 */
const PAY_PAGE = '/pages/pay/index';
/** A7：再次购买后去购物车（tab 页，只能 switchTab）；点商品行进详情。 */
const CART_PAGE = '/pages/cart/index';
const DETAIL_PAGE = '/pages/detail/index';
/** 售后申请页（AJ-420）；提交后出栈回本页，onShow 重取即看到进度。 */
const AFTER_SALE_PAGE = '/pages/after-sale/index';
/** 「我的」（tab 页）：客服联系方式在那里（AJ-433）。 */
const USER_PAGE = '/pages/user/index';
/** 订单列表（tab 页，只能 switchTab）。 */
const ORDER_LIST_PAGE = '/pages/order/index';

Page({
  data: {
    /** vm `detailView` 的输出；null = 还没拉到（此时只显示加载/错误）。 */
    view: null,
    loading: false,
    /** A7：再次购买放不进购物车时的说明（空串 = 不显示）。 */
    buyAgainNote: '',
    /** 错误态是否给"重试"（P2-38）：链接里没有订单 id 时为 false。 */
    retryable: false,
    /** 订单不存在（40400）或链接里没有 id：按钮去订单列表（vm `orderNotFound`）。 */
    notFound: false,
    /** 错误文案（空串 = 无错误）。 */
    error: '',
    /** AJ-433：错误态按钮去客服（账号被拉黑）而不是重试。 */
    errorContact: false,
    /** 取消请求在途（ws-button 会吞掉这期间的连点）。 */
    cancelling: false,
    confirmingReceipt: false,
    /** 刚复制的是哪一个：'order' 订单号（M-05）/ 'no' 运单号 / 'url' 查件链接 / '' 都没有（各自显示「已复制」，@see @limitation 三）。 */
    copied: '',
    /**
     * 复制失败的提示与位置（F9，第二轮审计 2026-10-11）：'order' 订单号旁 / 'tracking' 物流卡里。
     * @why 原先写进 `error`，页面顶部弹出"订单信息没能取到或操作没有完成"——订单明明好好的，只是剪贴板没写进去。
     */
    copyError: '',
    copyErrorAt: '',
    /** 取消 / 确认收货撞上 40902 / 40904 后重取订单，给一句说明（MP-7，vm `actionFailure`）。 */
    actionNote: '',
    /** 剩余清单 4-2：客服联系方式（utils/support.js）；空数组 = 未配置，不显示。 */
    support: [],
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
  /**
   * 剩余分钟的走表（三天提交复查 2026-10-12：原先只在取数时算一次，开着页面会一直写"28 分钟"）。
   * 只在待付款且有剩余分钟时走；离开页面（onHide / onUnload）就停。
   */
  payTick: null,
  /** 最近一次拿到的订单原文（放弃 justPaid 假设后要按它重渲染）。 */
  lastOrder: null,
  /**
   * 取数序号（F12，第二轮审计 2026-10-11）：onShow、下拉刷新、复核定时器、操作后重取会并发 `load`，
   * 先发后到的旧响应会把新状态盖回去（例如刚取消成功，又被一次在途的旧响应盖回"待付款"）。
   */
  loadSeq: 0,

  onLoad(options) {
    this.orderId = typeof options?.id === 'string' ? options.id : '';
    this.traceId = newTraceId();
    this.alive = true;
    // 刚从支付页过来（微信支付成功带 justPaid=1），或这张单刚在浏览器里发起过银行卡付款（W-02）：
    // 两种情况支付通知都可能还没到，先显示"确认中"、退避重查，而不是给出"继续支付 / 取消订单"。
    this.justPaid =
      options?.justPaid === '1' ||
      recentExternalPay(app.globalData.externalPay, this.orderId, Date.now());
    this.recheckCount = 0;
    this.recheckGaveUp = false;
    // @see @limitation 一：空 id 不发请求
    if (this.orderId === '')
      this.setData({
        error: '链接里缺少订单信息，可以在「订单」里查看你的全部订单',
        retryable: false,
        notFound: true,
      });
    else this.setData({ retryable: true });
    // 剩余清单 4-2：订单出问题时最需要客服——拉一次联系方式，失败静默（只是不显示这张卡）
    app.globalData
      .api({ url: `${app.globalData.apiBase}/api/v1/support`, traceId: this.traceId })
      .then((res) => {
        // 独立审查 2026-10-13 【2】：页面已销毁就不 setData（与定时器必清同一口径）
        if (this.alive) this.setData({ support: supportRows(res) });
      })
      .catch(() => undefined);
  },

  onUnload() {
    this.alive = false;
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.stopPayTick();
    // 审计 BUG-03：在途的详情请求回来后作废，不再起重查 / 付款倒计时
    this.loadSeq = nextSeq(this.loadSeq);
  },

  onHide() {
    this.stopPayTick();
  },

  stopPayTick() {
    if (this.payTick !== null) clearTimeout(this.payTick);
    this.payTick = null;
  },

  /**
   * 每 30 秒按最新时刻重算一次视图（只改剩余分钟这类随时间变的字）；分钟走完就重取一次订单（服务端会关单）。
   * @why 链式 setTimeout 而不是 setInterval：与支付页倒计时同口径（小程序端 eslint 全局白名单只登记了 setTimeout）。
   */
  startPayTick() {
    this.stopPayTick();
    if (this.data.view?.payLeftText === '' || this.data.view?.payLeftText === undefined) return;
    this.payTick = setTimeout(() => {
      this.payTick = null;
      if (this.lastOrder === null) return;
      const view = detailView(this.lastOrder, {
        justPaid: this.justPaid,
        recheckGaveUp: this.recheckGaveUp,
        nowMs: serverNowMs(Date.now(), app.globalData.clockSkewMs),
      });
      this.setData({ view });
      if (view.payLeftText === '') void this.load();
      else this.startPayTick();
    }, 30_000);
  },

  /**
   * 错误态按钮（P2-38）：重取这张单（没有 id 时 wxml 不给按钮）；
   * 账号被拉黑（errorContact，AJ-433）时去「我的」找客服——重试永远不会成功。
   */
  onRetry() {
    // 订单不存在（40400）/ 链接里没有 id：重取无用，去订单列表（全入口点击测试 2026-10-11）
    if (this.data.notFound === true) {
      wxApi.switchTab({ url: ORDER_LIST_PAGE });
      return;
    }
    if (this.data.errorContact === true) {
      wxApi.switchTab({ url: USER_PAGE });
      return;
    }
    if (this.orderId !== '') void this.load();
  },

  onShow() {
    track(app, 'page_view', { page: 'order_detail' }); // M-21 页面曝光
    this.adoptPaidReturn();
    if (this.orderId !== '') void this.load();
  },

  /**
   * 支付页退回本页时交回的"刚付过"（MP-10，第二轮审计 2026-10-11）。
   * @why 支付页从本页进去、付完 navigateBack 回来（不再 redirectTo 出第二张详情），而 navigateBack 带不了参数——
   *      "刚付过"经 `globalData.paidReturn` 交回；只认本单的，读完即清（别的单的不动，那是别的详情页的）。
   * @why 银行卡（copylink）路径"查看订单"退回时不带 justPaid，但本机记过"刚在浏览器发起付款"——照 onLoad 同一判断补上。
   */
  adoptPaidReturn() {
    const r = app.globalData.paidReturn;
    if (r === null || typeof r !== 'object' || r.orderId !== this.orderId) return;
    app.globalData.paidReturn = null;
    if (
      r.justPaid === true ||
      recentExternalPay(app.globalData.externalPay, this.orderId, Date.now())
    ) {
      this.justPaid = true;
      this.recheckCount = 0;
      this.recheckGaveUp = false;
    }
  },

  /**
   * 下拉刷新（M-04，AJ-405）：重取这张单，**取完**再收起动画（成功失败都收）。
   * @why 没有 id 时不发请求（@limitation 一），但动画仍要收起——否则顶部一直转圈。
   */
  async onPullDownRefresh() {
    this.setData({ actionNote: '' });
    if (this.orderId !== '') await this.load();
    wxApi.stopPullDownRefresh();
  },

  /** 取详情。失败**清空视图**并明示错误（留旧数据 = 把旧状态当真值）。 */
  async load() {
    const seq = (this.loadSeq = nextSeq(this.loadSeq));
    this.setData({ loading: true });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}`,
        traceId: this.traceId,
      });
      if (isStale(seq, this.loadSeq)) return;
      this.lastOrder = res;
      this.setData({
        view: detailView(res, {
          justPaid: this.justPaid,
          recheckGaveUp: this.recheckGaveUp,
          // MP-8：截止判定用校准过的时刻（手机时钟偏快时不会提前判"已过期"）
          nowMs: serverNowMs(Date.now(), app.globalData.clockSkewMs),
        }),
        error: '',
        errorContact: false,
        notFound: false,
        copied: '',
        copyError: '',
        copyErrorAt: '',
      });
      this.scheduleRecheck();
      this.startPayTick();
    } catch (e) {
      if (isStale(seq, this.loadSeq)) return;
      this.setData({ view: null, ...errorFields(e), ...contactFields(e), ...orderNotFound(e) });
    } finally {
      if (!isStale(seq, this.loadSeq)) this.setData({ loading: false });
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
      // 提示留到页面关闭（之后的刷新若仍待付款也照样提示：钱可能仍在路上，统一结论 5.3）
      this.justPaid = false;
      this.recheckGaveUp = true;
      this.setData({
        view: detailView(this.lastOrder, {
          justPaid: false,
          recheckGaveUp: true,
          nowMs: serverNowMs(Date.now(), app.globalData.clockSkewMs),
        }),
      });
      return;
    }
    this.recheckCount += 1;
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => void this.load(), 1500 * this.recheckCount);
  },

  /**
   * 再次购买（A7，AJ-416）：这单的商品与数量放回购物车，然后去购物车（重新报价、重新勾选结算）。
   * @why 放不进去（品种已满）就**留在本页说清楚**：跳到购物车却少了几件，用户会以为是这一单的商品下架了。
   * @limitation 已在车里的同款**调到这单的数量**（不叠加；全入口点击测试 2026-10-11，点两次原先会变双份），
   *             车里本来更多的不往下改（审计 BUG-14），并只勾选这几件；页面不另行提示数量变化。
   * @limitation 购物车品种已满时部分商品放不进去：已改的数量保留、不聚焦（三天提交复查 2026-10-12 记录，暂不回滚）。
   */
  onBuyAgain() {
    const cart = app.globalData.cart;
    // 全入口点击测试 2026-10-11：购物车里已有的改成这单的数量，不叠加——点两次「再次购买」原先会变成双份
    // 审计 BUG-14：已在车里的只往上调到这单的数量，不往下改（买家自己加多了的不被覆盖少）
    const inCart = new Map(cart.items().map((i) => [i.productId, i.qty]));
    const placed = [];
    const rejected = buyAgainItems(this.lastOrder).filter((i) => {
      const had = inCart.get(i.productId);
      if (had !== undefined) {
        if (had < i.qty) cart.setQty(i.productId, i.qty);
        placed.push(i.productId);
        return false;
      }
      if (cart.add(i)?.added === true) {
        placed.push(i.productId);
        return false;
      }
      return true;
    });
    // 部分放进去了：放进去的照样排到最上面、只勾它们，留在本页说明没放进的件数
    if (placed.length > 0) cart.focusOn(placed);
    if (rejected.length > 0) {
      this.setData({
        buyAgainNote: `购物车商品种类已满，${rejected.length} 种商品没放进去，请先清理购物车`,
      });
      return;
    }
    this.setData({ buyAgainNote: '' });
    wxApi.switchTab({ url: CART_PAGE });
  },

  /** 点商品行进详情（A7）：看看现在还卖不卖、什么价。 */
  onOpenItem(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(id)}` });
  },

  /** 申请售后（AJ-420，仅 `afterSale.canApply`）。用 order_id（内部 id）而不是订单号：接口按 id 定位。 */
  onApplyAfterSale() {
    if (this.orderId === '' || this.data.view?.afterSale?.canApply !== true) return;
    // 全入口点击测试 2026-10-11：把订单摘要交给售后页（它顶部显示是哪一单，不另发请求；读走即清）
    app.globalData.afterSaleBrief = afterSaleBrief(this.orderId, this.data.view);
    wxApi.navigateTo({ url: `${AFTER_SALE_PAGE}?id=${encodeURIComponent(this.orderId)}` });
  },

  /** 继续支付（仅 `canPay`；不传金额，支付页自己向服务端要权威金额）。 */
  onPay() {
    // 审计 ITX-06：取消在途时不去付款（原生 disabled 在部分基础库仍会触发点击；取消成功后这张单就付不了了）
    if (this.data.cancelling === true) return;
    // MP-10：带 from=detail，支付页付完退回本页（不再 redirectTo 出第二张详情）
    wxApi.navigateTo({
      url: `${PAY_PAGE}?orderId=${encodeURIComponent(this.orderId)}&from=detail`,
    });
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
      success: () => this.setData({ copied: kind, copyError: '', copyErrorAt: '' }),
      // F9：就近提示，不动顶部错误态（订单本身没问题）；运单号 / 链接文本可长按选中（wxml user-select）
      fail: () =>
        this.setData({
          copied: '',
          copyError: copyFailText(app.globalData.privacy, '复制失败，请长按运单号手动复制'),
          copyErrorAt: 'tracking',
        }),
    });
  },

  /**
   * 复制订单号（M-05，AJ-405）：买家联系客服时要报单号，此前它是普通 text、长按也选不中。
   * @why 复制 `order_no`（买家与客服都认的那串），不是内部 `order_id`。
   * @why 反馈用页内"已复制"而不是 toast（与运单号同口径，@see @limitation 三；对标分析 §6 保持页内提示）。
   */
  onCopyOrderNo() {
    const no = this.data.view?.orderNo;
    if (typeof no !== 'string' || no === '') return;
    wxApi.setClipboardData({
      data: no,
      success: () => this.setData({ copied: 'order', copyError: '', copyErrorAt: '' }),
      fail: () =>
        this.setData({
          copied: '',
          copyError: copyFailText(app.globalData.privacy, '复制失败，请长按订单号手动复制'),
          copyErrorAt: 'order',
        }),
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

  /** 确认收货（P2-13 / AJ-387）：二次确认后 POST，成功原地重取。 */
  onConfirmReceiptTap() {
    wxApi.showModal({
      title: '确认收货',
      content: '确认已收到全部商品？确认后有问题，仍可在本页「申请售后」。',
      confirmText: '已收到',
      cancelText: '还没收到',
      success: (r) => {
        if (r?.confirm === true) void this.confirmReceipt();
      },
    });
  },

  async confirmReceipt() {
    this.setData({ confirmingReceipt: true, error: '', actionNote: '' });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/confirm-receipt`,
        method: 'POST',
        traceId: this.traceId,
      });
      // 体验审查 2026-10-15（P1-2）：订单列表已改为"有变化才重取"，这里是那个"变化"——
      //   不置位的话，本页刚确认收货、返回列表那一行还是「待收货」，且列表不会自己纠正。
      app.globalData.ordersChanged = true;
      await this.load();
    } catch (e) {
      await this.afterActionFailure(e);
    } finally {
      this.setData({ confirmingReceipt: false });
    }
  },

  /**
   * 取消 / 确认收货失败（MP-7，第二轮审计 2026-10-11）：状态已变（40902）/ 已过期（40904）→ 重取订单再说明，
   * 不把过期的按钮留在页面上；其余错误走通用错误态。
   * @why 说明在重取**之后**写：`load` 成功会清 `error`，先写后取会被抹掉。
   */
  async afterActionFailure(e) {
    const f = actionFailure(e);
    if (!f.reload) {
      this.setData({ ...errorFields(e), ...contactFields(e) });
      return;
    }
    await this.load();
    this.setData({ actionNote: f.note });
  },

  /** 发取消请求；成功后**原地重取**（@see 文件头 @why）。 */
  async cancel() {
    this.setData({ cancelling: true, error: '', actionNote: '' });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/${this.orderId}/cancel`,
        method: 'POST',
        traceId: this.traceId,
      });
      // 体验审查 2026-10-15（P1-2）：同 confirmReceipt——刚取消的单不能在返回列表后还挂着「继续支付」
      app.globalData.ordersChanged = true;
      await this.load();
    } catch (e) {
      await this.afterActionFailure(e);
    } finally {
      this.setData({ cancelling: false });
    }
  },
});
