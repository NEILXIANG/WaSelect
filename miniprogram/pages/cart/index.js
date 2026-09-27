/**
 * 职责：购物车页薄壳——读本地购物车 → 调 vm → 向 `POST /orders/quote` 要权威合计。
 *
 * ⚠️ 与首页/详情同一条纪律：视图判断都在 `index.vm.js`（纯函数，8 条单测），
 *    这里只做生命周期取数、`setData`、宿主调用。
 *
 * @why 用 `onShow` 而不是 `onLoad` 刷新：详情页加购后**返回**购物车不会触发 onLoad
 *      （页面在栈里没销毁），只看 onLoad 的表现是"加了东西，返回购物车看不到"——
 *      那种"我明明加了"的错觉比报错更伤信任。
 *
 * @why quote 有**防抖**（`QUOTE_DEBOUNCE_MS`）：连点 +/- 每点一次就打一次报价，
 *      而报价端点带 429 限流（契约已声明）——客户端不该把自己限死。
 *      防抖只影响"打不打电话"，本地数量与金额显示是**立刻**更新的（不等待网络）。
 *
 * @limitation 一：**去结算只在报价出来后才可用**（`quote.totalJpy` 非 null）——
 *              结算页要拿这个数做 `expected_total_jpy` 防线（40905），
 *              没有合计就跳过去 = 带着一个"防线已降级"的状态下单，而页面上看不出来。
 * @limitation 二：报价失败**不清列表**（本地条目还在，用户能继续改数量），
 *              只显示错误文案；下一次改动会自然重试。
 *
 * @see ./index.vm.js（行视图真源）；../../utils/quote-view.js（报价区视图，共享层）；
 *      ../../utils/cart-store.js（本地状态真源）
 */
import { cartRows } from './index.vm.js';
import { quoteView } from '../../utils/quote-view.js';
import { errorMessage } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 报价防抖毫秒数（@why 见文件头）。 */
const QUOTE_DEBOUNCE_MS = 400;

/** 结算页路径（跳转路径只在这一处出现）。 */
const CHECKOUT_PAGE = '/pages/checkout/index';

/** 去结算按钮的禁用原因（@see @limitation 一）。 */
const CHECKOUT_HINT = '运费与合计还在计算中';

Page({
  data: {
    /** vm `cartRows` 的输出（本地快照渲染）。 */
    rows: [],
    /** vm `quoteView` 的输出；null = 还没报价（报价区隐藏）。 */
    quote: null,
    /** 件数合计（标题显示用）。 */
    count: 0,
    empty: false,
    quoting: false,
    /** 报价错误文案（空串 = 无错误）。 */
    quoteError: '',
    checkoutHint: CHECKOUT_HINT,
  },

  /** 防抖定时器句柄（不进 data：它不是渲染状态）。 */
  quoteTimer: null,
  /** 一次"逛购物车"一条链：报价请求都复用它。 */
  traceId: '',

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    this.refresh();
  },

  onUnload() {
    // ⚠️ 页面销毁时清掉挂起的定时请求：它会去调一个已销毁页面的 setData，
    //    那种报错指向 setData 而不是"定时器没清"，排查方向会被引偏。
    if (this.quoteTimer !== null) {
      clearTimeout(this.quoteTimer);
      this.quoteTimer = null;
    }
  },

  /** 重读本地购物车并（防抖地）重新报价。 */
  refresh() {
    const rows = cartRows(app.globalData.cart.items());
    this.setData({
      rows,
      count: app.globalData.cart.count(),
      empty: rows.length === 0,
    });
    if (rows.length === 0) {
      // 空车不报价：空 items 会被服务端 40001 拒，而"打开空购物车有个错误提示"是荒谬的
      this.setData({ quote: null, quoteError: '' });
      return;
    }
    this.requestQuote();
  },

  /** 防抖地打一次报价（连点 +/- 只打最后一次，@why 见文件头）。 */
  requestQuote() {
    if (this.quoteTimer !== null) clearTimeout(this.quoteTimer);
    this.quoteTimer = setTimeout(() => {
      this.quoteTimer = null;
      void this.fetchQuote();
    }, QUOTE_DEBOUNCE_MS);
  },

  /** `POST /orders/quote`——合计的**唯一**来源（本地快照价不算钱）。 */
  async fetchQuote() {
    this.setData({ quoting: true, quoteError: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/quote`,
        method: 'POST',
        data: { items: app.globalData.cart.toOrderItems() },
        traceId: this.traceId,
      });
      this.setData({ quote: quoteView(res) });
    } catch (e) {
      this.setData({ quote: null, quoteError: errorMessage(e) });
    } finally {
      this.setData({ quoting: false });
    }
  },

  /** - / + 改数量（本地立刻生效，报价走防抖）。 */
  onMinus(e) {
    this.changeQty(this.idOf(e), -1);
  },

  onPlus(e) {
    this.changeQty(this.idOf(e), 1);
  },

  onRemove(e) {
    app.globalData.cart.remove(this.idOf(e));
    this.refresh();
  },

  changeQty(productId, delta) {
    if (productId === '') return;
    const cart = app.globalData.cart;
    const current = cart.items().find((i) => i.productId === productId);
    if (current === undefined) return;
    // ⚠️ 减到 0 由 cart-store 定义为"移除"（setQty 的 @why）；这里不额外判断
    cart.setQty(productId, current.qty + delta);
    this.refresh();
  },

  /**
   * 去结算（@see @limitation 一：没有权威合计时不让走）。
   * @why 不传任何金额给结算页：金额一律由结算页自己向服务端要（跨页传金额 = 可被篡改）。
   */
  onCheckout() {
    if (this.data.quote === null || this.data.quote.totalJpy === null) return;
    wxApi.navigateTo({ url: CHECKOUT_PAGE });
  },

  /** 取 wxml 的 `data-id`（取不到 = 空串，而不是 undefined）。 */
  idOf(e) {
    const id = e?.currentTarget?.dataset?.id;
    return typeof id === 'string' ? id : '';
  },
});
