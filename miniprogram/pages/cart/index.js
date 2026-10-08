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
 * @limitation 一：**去结算只在报价出来后才可用**（`gate.disabled`，由 vm 的
 *              `checkoutGate` 产出）——结算页要拿这个数做 `expected_total_jpy` 防线（40905），
 *              没有合计就跳过去 = 带着一个"防线已降级"的状态下单，而页面上看不出来。
 *              ⚠️ B36 / AJ-219 起，"报价在途中"也算禁用：那时页面上的合计是**改数量之前**
 *              的那一版，放行等于把过期的 expected_total_jpy 喂给结算页。
 * @limitation 二：报价失败**不清列表**（本地条目还在，用户能继续改数量），
 *              只显示错误文案；下一次改动会自然重试。
 *              ⚠️ 但提示语必须说"未能获取"（B36 / AJ-219）——以前一律说"还在计算中"，
 *              用户会一直等一个永远算不出来的合计。
 *
 * @see ./index.vm.js（行视图真源）；../../utils/quote-view.js（报价区视图，共享层）；
 *      ../../utils/cart-store.js（本地状态真源）
 */
import {
  UNDO_WINDOW_MS,
  cartRows,
  checkoutGate,
  intentForRow,
  markInvalid,
  pendingRemoval,
  quoteErrorText,
  quoteRetryable,
  undoAvailable,
  undoView,
} from './index.vm.js';
import { quoteView } from '../../utils/quote-view.js';
import { errorFields, errorMessage } from '../../utils/error-text.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';
import { track } from '../../utils/beacon.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/** 报价防抖毫秒数（@why 见文件头）。 */
const QUOTE_DEBOUNCE_MS = 400;

/** 结算页路径（跳转路径只在这一处出现）。 */
const CHECKOUT_PAGE = '/pages/checkout/index';
/** 商品详情（M-14：点行进详情；非 tab 页，navigateTo）。 */
const DETAIL_PAGE = '/pages/detail/index';
/** 首页（tab 页，剩余清单 4-8 空态出口）。 */
const HOME_PAGE = '/pages/home/index';

/**
 * 报价里有没有权威合计。
 * @why `!= null` 同时排除 null 与 undefined：契约的 `total_jpy` 缺失与显式 null
 *      在"能不能拿去做 expected_total_jpy"上是同一件事，不该分两种判据。
 */
const hasTotal = (quote) => quote?.totalJpy != null;

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
    /**
     * 上一次报价失败的业务错误码（0 = 没有 / 认不出）。
     * @why 提示语要分"稍后重试就好"与"必须改购物车"两类（MP3-09）：
     *      对超重（40912）说"请稍后重试"是句谎话——它不会自己变轻。
     */
    quoteErrorCode: 0,
    /** M-14（AJ-406）：报价失败时给不给"重试"（vm `quoteRetryable`）。 */
    quoteRetry: false,
    /** M-14：删除后"已删除 · 撤销"那一行（vm `undoView`）。 */
    undo: { show: false, index: -1, text: '' },
    /** 「去结算」的状态（vm `checkoutGate` 的输出：能不能点 + 说什么）。 */
    gate: { disabled: true, hint: '运费与合计还在计算中' },
  },

  /** 防抖定时器句柄（不进 data：它不是渲染状态）。 */
  quoteTimer: null,
  /** 一次"逛购物车"一条链：报价请求都复用它。 */
  traceId: '',
  /** 报价请求序号（B36 / AJ-219：只接受最新一次报价的结果）。 */
  quoteSeq: 0,
  /** M-14：最近一次删除的可撤销状态（vm `pendingRemoval`）；null = 没有。不进 data：渲染态是 `undo`。 */
  pending: null,
  /** M-14：撤销窗口到点后收起那一行的定时器（只管"收起"，能否撤销以时刻为准，见 vm `undoAvailable`）。 */
  undoTimer: null,

  onLoad() {
    this.traceId = newTraceId();
  },

  onShow() {
    track(app, 'page_view', { page: 'cart' }); // M-21 页面曝光
    this.refresh();
    // S5：注入底部 tabBar 的高亮（本页是第 1 个 tab）。
    // @why 与取数**并列**而不是放进 refresh：refresh 也会被结算成功后调用，
    //      而"更新高亮"是进屏的事，混进"重读购物车"会让两件事的触发时机绑在一起。
    setActiveTab(this, 'cart');
  },

  onUnload() {
    // ⚠️ 页面销毁时清掉挂起的定时请求：它会去调一个已销毁页面的 setData，
    //    那种报错指向 setData 而不是"定时器没清"，排查方向会被引偏。
    if (this.quoteTimer !== null) {
      clearTimeout(this.quoteTimer);
      this.quoteTimer = null;
    }
    this.clearUndoTimer();
  },

  /** 重读本地购物车并（防抖地）重新报价。 */
  refresh() {
    const rows = cartRows(app.globalData.cart.items());
    // M-14：删光最后一件时仍要显示"已删除 · 撤销"——此时不能切到空态，否则撤销入口跟着消失
    const undo = undoView(this.pending, Date.now());
    this.setData({
      rows,
      undo,
      count: app.globalData.cart.count(),
      empty: rows.length === 0 && !undo.show,
    });
    // M-14（AJ-406）：tabBar 角标——进屏与本页每次改动都走这里（utils/tabs.js 唯一更新方）
    setCartBadge(this, app.globalData.cart);
    if (rows.length === 0) {
      // 空车不报价：空 items 会被服务端 40001 拒，而"打开空购物车有个错误提示"是荒谬的
      // ⚠️ 但必须**同时**清掉挂起的防抖定时器并把序号推进（B36 / AJ-219）：
      //    不清的话，刚才连点"+"排上的那次报价仍会在 400ms 后发出——
      //    此时购物车已经空了，它会拿空 items 去打报价，拿到 40001，
      //    表现是"清空购物车之后冒出一个错误"（清空的动作看起来失败了）。
      if (this.quoteTimer !== null) {
        clearTimeout(this.quoteTimer);
        this.quoteTimer = null;
      }
      this.quoteSeq = nextSeq(this.quoteSeq);
      this.setData({
        quote: null,
        quoteError: '',
        quoteErrorCode: 0,
        gate: checkoutGate({ hasTotal: false }),
      });
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
    // B36 / AJ-219：领号。连点 +/- 之后防抖只发最后一次，但**上一次**可能还在途中——
    // 它若后回来，会把旧合计盖回去（改完数量显示旧合计，且"去结算"带着它走）。
    const seq = (this.quoteSeq = nextSeq(this.quoteSeq));
    this.setData({
      quoting: true,
      quoteError: '',
      quoteRetry: false,
      gate: checkoutGate({ quoting: true }),
    });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/orders/quote`,
        method: 'POST',
        data: { items: app.globalData.cart.toOrderItems() },
        traceId: this.traceId,
      });
      if (isStale(seq, this.quoteSeq)) return;
      const quote = quoteView(res);
      // 行价跟着报价走（契约 0.6.39 lines；三端联动模拟 2026-10-08）：店家改价后快照价过期，
      // 原先同一屏"行价 1,400 円 / 商品合计 1,600 円"对不上
      const repriced = app.globalData.cart.syncPrices(res?.lines);
      this.setData({
        quote,
        // 报价通过 → 清掉上一次的失效标记（剩余清单 4-7）
        rows: markInvalid(
          repriced ? cartRows(app.globalData.cart.items()) : this.data.rows,
          undefined,
          0,
        ),
        gate: checkoutGate({
          hasTotal: hasTotal(quote),
          splitRequired: quote?.splitRequired === true,
        }),
      });
    } catch (e) {
      if (isStale(seq, this.quoteSeq)) return;
      const code = e !== null && typeof e === 'object' && Number.isInteger(e.code) ? e.code : 0;
      const lineCount = this.data.rows.length;
      this.setData({
        quote: null,
        // 剩余清单 4-7：服务端指出是哪一件（e.data.product_id）→ 标红那一行
        rows: markInvalid(this.data.rows, e?.data?.product_id, code),
        ...errorFields(e, 'quoteError'),
        // P2-31：品种超限（40001 + >50 行）换成"请移除一些"，否则永远是一句重试不好的错
        quoteError: quoteErrorText(code, lineCount, errorMessage(e)),
        quoteErrorCode: code,
        // M-14：重试可能有用时才给按钮（下架 / 超重等必须改购物车的不给）
        quoteRetry: quoteRetryable(code, lineCount),
        gate: checkoutGate({ hasError: true, errorCode: code, lineCount }),
      });
    } finally {
      // 同首页：过期请求不能把 quoting 清掉（新的还在途中）
      if (!isStale(seq, this.quoteSeq)) {
        this.setData({
          quoting: false,
          gate: checkoutGate({
            hasTotal: hasTotal(this.data.quote),
            hasError: this.data.quoteError !== '',
            errorCode: this.data.quoteErrorCode,
            lineCount: this.data.rows.length,
            splitRequired: this.data.quote?.splitRequired === true,
          }),
        });
      }
    }
  },

  /** - / + 改数量（本地立刻生效，报价走防抖）。 */
  onMinus(e) {
    this.changeQty(this.idOf(e), -1);
  },

  onPlus(e) {
    this.changeQty(this.idOf(e), 1);
  },

  /**
   * 删除（M-14，AJ-406）：立刻删，行内给"撤销"，不弹确认框（对标分析 §4：撤销优于弹窗，不打断）。
   * @why 再删第二件时**覆盖**上一个撤销：只保留最近一次——同时挂两条"已删除"会把列表变成墓地，
   *      而"连删两件后想撤回第一件"在 5 秒内极少见。
   */
  onRemove(e) {
    const id = this.idOf(e);
    if (id === '') return;
    const cart = app.globalData.cart;
    this.pending = pendingRemoval(cart.items(), id, Date.now());
    cart.remove(id);
    this.clearUndoTimer();
    if (this.pending !== null) {
      // 到点只负责把那一行收起来；能否撤销由 vm 按时刻判（定时器在后台会被冻结）
      this.undoTimer = setTimeout(() => {
        this.undoTimer = null;
        this.pending = null;
        this.refresh();
      }, UNDO_WINDOW_MS);
    }
    this.refresh();
  },

  /** 撤销删除（M-14）：窗口内放回原位置；过了窗口只收起那一行。 */
  onUndo() {
    const pending = this.pending;
    this.pending = null;
    this.clearUndoTimer();
    if (undoAvailable(pending, Date.now()))
      app.globalData.cart.restore(pending.item, pending.index);
    this.refresh();
  },

  clearUndoTimer() {
    if (this.undoTimer !== null) {
      clearTimeout(this.undoTimer);
      this.undoTimer = null;
    }
  },

  /**
   * 报价失败后的"重试"（M-14）：直接重报一次（不走防抖——用户明确要求了现在就算）。
   * @why 在途时不重复发：序号会丢弃旧结果，但多打一次报价端点（有 429 限流）没有意义。
   */
  onRetryQuote() {
    if (this.data.quoting === true) return;
    if (this.data.rows.length === 0) return;
    void this.fetchQuote();
  },

  /** 点行（图 / 标题）进详情（M-14）。步进与删除是单独的点击区，不会误触跳走。 */
  onOpenDetail(e) {
    const intent = intentForRow(this.idOf(e));
    if (intent === null) return;
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(intent.id)}` });
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
    // @see @limitation 一：权威合计没出来不让走；`gate` 是同一个判断的**渲染态**
    if (this.data.gate?.disabled !== false) return;
    if (!hasTotal(this.data.quote)) return;
    wxApi.navigateTo({ url: CHECKOUT_PAGE });
  },

  /** 取 wxml 的 `data-id`（取不到 = 空串，而不是 undefined）。 */
  idOf(e) {
    const id = e?.currentTarget?.dataset?.id;
    return typeof id === 'string' ? id : '';
  },

  /** 空态"去逛逛"（剩余清单 4-8）：首页是 tab 页，只能 switchTab。 */
  onGoShopping() {
    wxApi.switchTab({ url: HOME_PAGE });
  },
});
