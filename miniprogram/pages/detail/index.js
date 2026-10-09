/**
 * 职责：商品详情页薄壳——`onLoad` 取 id → 取数 → 调 vm → `setData`。
 *
 * ⚠️ 与首页同一条纪律：视图判断都在 `index.vm.js`（纯函数，11 条单测），
 *    这里只允许"生命周期与取数 / setData / 宿主能力调用"三类代码。
 *
 * @why 详情页是首页卡片跳转的**落点**：`pages/home` 的卡片 tap 生成导航意图
 *      （vm 的 `intentForProduct`），由首页 shell 拼路径跳过来。id 是唯一入参——
 *      没有它的详情页只会白屏，所以缺 id 时**明示错误**，不渲染空壳。
 *
 * @why「立即购买」（剩余清单 4-4）只结这一件：条目放 `globalData.buyNow`，结算页 `?mode=buynow` 只读它、
 *      建单后不清购物车（vm `buyNowItem` / 结算页 vm `checkoutItems`）。
 *
 * @limitation 一：分享（`onShareAppMessage`，剩余清单 4-4）卡片只带商品 id；有 AppID 之后才真正可点开，
 *              开发者工具里只能看到卡片形态。
 * @limitation 二：轮播用原生 `swiper`，**没有**指示器自定义样式——默认圆点即可，
 *              为一个还没定版的页面先做指示器属于提前设计。
 *
 * @why M-03（AJ-405）：客服联系方式与订单详情同源（`GET /support` → utils/support.js）；
 *      拉取失败静默——它只是"多一个出口"，不该让整页报错。
 *
 * @see ./index.vm.js（视图逻辑真源）；../home/index.vm.js（导航意图真源）
 */
import {
  acceptAddTap,
  addFeedback,
  buyBarView,
  buyNowItem,
  detailView,
  shareCard,
  addLimit,
  retryableLoadError,
  stillAdded,
  stepQty,
  relatedCards,
} from './index.vm.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';
import { supportRows } from '../../utils/support.js';
import { track } from '../../utils/beacon.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/**
 * 购物车页路径（跳转路径只在这一处出现）。
 * @why S5 之后它是 tab 页，跳转**必须**走 `switchTab`（`navigateTo` 会被宿主拒绝，
 *      表现是"点了没反应"，日志里只有一行宿主文案）。
 */
const CART_PAGE = '/pages/cart/index';
/** A10：同类推荐点进去 / 下架时回首页。 */
const DETAIL_PAGE = '/pages/detail/index';
const HOME_PAGE = '/pages/home/index';
/** 同类推荐多取几件，排掉本品与售罄后仍够 4 件（vm RELATED_MAX）。 */
const RELATED_FETCH_SIZE = 10;
/** 结算页（立即购买带 mode=buynow，剩余清单 4-4）。 */
const CHECKOUT_BUY_NOW = '/pages/checkout/index?mode=buynow';

Page({
  data: {
    /** vm `detailView` 的输出；null = 还没拿到数据（wxml 显示加载态）。 */
    product: null,
    loading: false,
    /** A9（AJ-416）：这次要加 / 要买几件（vm `stepQty`）。 */
    qty: 1,
    /** A10（AJ-416）：同类推荐（vm `relatedCards`）；空数组 = 不显示那一块。 */
    related: [],
    /** 错误文案（空串 = 无错误）。缺 id / 40401（下架或不存在）都会落到这里。 */
    error: '',
    /** true = 本次加购已成功（页内提示，不弹 toast——又一个宿主 API 不值得登记）。 */
    added: false,
    /** 没加进去的原因（P2-31：品种已满）；空串 = 不显示。 */
    addNote: '',
    /** 错误态是否给"重试"（P2-38）：缺 id 时重试也没用，不给按钮。 */
    retryable: false,
    /** M-03：客服联系方式（utils/support.js）；空数组 = 未配置，不显示。 */
    support: [],
    /** M-13（AJ-406）：底部固定购买栏（vm `buyBarView`）。 */
    bar: { cartText: '购物车', cartAria: '购物车，去购物车', disabled: false },
  },

  /** 上一次被接受的加购时刻（P2-37 连点守卫；不进 data：不是渲染状态）。 */
  lastAddAt: 0,
  /** 上一次被接受的"立即购买"时刻（审查 2026-10-09：连点会压入两个结算页）。 */
  lastBuyAt: 0,

  productId: '',
  /** 一次"看一个商品"是一条链：详情页只有一次取数，链路从 onLoad 开始。 */
  traceId: '',

  /**
   * @param {{id?: string}} options 首页跳转带来的 query（`?id=…`）
   */
  onLoad(options) {
    this.traceId = newTraceId();
    // ⚠️ 不 decodeURIComponent：商品 id 是服务端生成的 slug（[a-z0-9-]），
    //    decode 对含 % 的恶意串会抛 URIError——原样透传给服务端去拒更安全。
    this.productId = typeof options?.id === 'string' ? options.id : '';
    if (this.productId === '') {
      this.setData({ error: '缺少商品 id', retryable: false });
      return;
    }
    this.load();
    // M-03（AJ-405）：保障区的客服入口——与订单详情同一条 GET /support，失败静默（只是不显示这张卡）
    app.globalData
      .api({ url: `${app.globalData.apiBase}/api/v1/support`, traceId: this.traceId })
      .then((res) => this.setData({ support: supportRows(res) }))
      .catch(() => undefined);
  },

  /**
   * 进屏刷新购买栏的购物车件数（M-13）：从购物车返回本页不触发 onLoad，只看 onLoad 件数会停在旧值。
   */
  onShow() {
    track(app, 'page_view', { page: 'detail' }); // M-21 页面曝光
    this.renderBar();
  },

  /** 购买栏 = 购物车件数 + 本次加购结果 + 售罄态（vm `buyBarView`）。 */
  /** 购物车里这件已有几件（加购上限与"已加入"复位共用）。 */
  inCartQty() {
    const cart = app.globalData.cart;
    const line =
      typeof cart?.items === 'function'
        ? cart.items().find((i) => i.productId === this.productId)
        : undefined;
    return line === undefined ? 0 : line.qty;
  },

  renderBar() {
    const cart = app.globalData.cart;
    // 去购物车删掉这件再回来："已加入"不再成立（审查 2026-10-09）
    if (this.data.added && !stillAdded(this.data.added, this.inCartQty())) {
      this.setData({ added: false });
    }
    this.setData({
      bar: buyBarView({
        cartCount: typeof cart?.count === 'function' ? cart.count() : 0,
        added: this.data.added,
        soldOut: this.data.product?.soldOut === true,
      }),
    });
  },

  /** 取详情。失败**清空商品**并明示错误：留旧数据会让人把别的商品当成这一个。 */
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/products/${this.productId}`,
        traceId: this.traceId,
      });
      const view = detailView(res);
      this.setData({ product: view });
      this.renderBar();
      void this.loadRelated(view.category);
    } catch (e) {
      this.setData({ product: null, ...errorFields(e), retryable: retryableLoadError(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 同类推荐（A10，AJ-416）：详情到了之后按分类取一页，排掉本品与售罄的。
   * @why 不阻塞详情：推荐是"顺便看看"，晚到或取不到都不该让商品本身慢一拍，所以不 await、不进 loading。
   * @why 取不到就**不显示那一块**、不报错：推荐区出一句"加载失败"会让人以为是这件商品出了问题。
   * @limitation 只按分类，不做"买了还买"之类的关联（没有足够的订单数据，见 AJ-416）。
   */
  async loadRelated(category) {
    if (typeof category !== 'string' || category === '') return;
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/products?category=${encodeURIComponent(category)}&size=${RELATED_FETCH_SIZE}`,
        traceId: this.traceId,
      });
      this.setData({ related: relatedCards(res?.items, this.productId) });
    } catch {
      this.setData({ related: [] });
    }
  },

  /** 点同类推荐 → 那件的详情（A10）。 */
  onOpenRelated(e) {
    const id = e?.currentTarget?.dataset?.id;
    if (typeof id !== 'string' || id === '') return;
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(id)}` });
  },

  /**
   * 错误态按钮（A10）：能重试的给"重试"；已下架 / 不存在（重试无用）给"去首页逛逛"——
   * 原先只剩一句红字和返回键，从分享卡片进来的人连返回都没有地方回。
   */
  onStateAction() {
    if (this.data.retryable) this.onRetry();
    else wxApi.switchTab({ url: HOME_PAGE });
  },

  /**
   * 加入购物车（数量取页面选的 qty，A9；购物车页还能再改）。
   * @why 快照信息（title/image/priceJpy）由这里备好交给 cart-store：
   *      购物车是**本地**状态，离线也要能看到加过什么；而快照价**不许**用来算钱
   *      （cart-store.js @limitation 一）。
   */
  onAddToCart() {
    const p = this.data.product;
    if (p === null || p.soldOut) return;
    if (this.productId === '') return;
    // P2-37：双击守卫——手抖点两下会让 qty 静默变成 2（判断在 vm，时间由这里传入）
    const now = Date.now();
    if (!acceptAddTap(this.lastAddAt, now)) return;
    this.lastAddAt = now;
    const qty = this.data.qty;
    const inCart = this.inCartQty();
    const limit = addLimit({ stock: p.stock, inCart, qty });
    if (!limit.ok) {
      this.setData(addFeedback({ added: false, reason: limit.reason, stock: limit.stock, inCart }));
      return;
    }
    const result = app.globalData.cart.add({
      productId: this.productId,
      qty,
      title: p.title,
      image: p.images[0] ?? '',
      priceJpy: p.priceJpy,
    });
    // ⚠️ 只提示、不跳走：加购后自动跳购物车会打断"继续逛"——用户自己点"去购物车"
    // P2-31：品种已满时 `added=false` + 说明，不假装加上了
    // M-21：只记真的加上了的（品种已满时 added=false，不算一次加购）
    if (result?.added === true) track(app, 'add_to_cart', { product_id: this.productId });
    this.setData(addFeedback(result));
    this.renderBar();
  },

  /** 错误态的"重试"（P2-38）：重新取详情。缺 id 时 wxml 不给按钮（retryable=false）。 */
  onRetry() {
    if (this.productId === '') return;
    void this.load();
  },

  /**
   * 去购物车（M-13 起是底部购买栏里的常驻入口）。
   * @why S5 之后用 `switchTab`：购物车是 tab 页。
   *      ⚠️ 代价是**回不到本页**（switchTab 会关掉所有非 tab 页）——
   *      但"去购物车"本来就是"我逛完了"的意思，返回需求由左上角返回键在
   *      进购物车**之前**满足，进之后不再需要。
   */
  onGoCart() {
    wxApi.switchTab({ url: CART_PAGE });
  },

  /** 立即购买（剩余清单 4-4）：只结这一件，不进购物车。 */
  /** A9（AJ-416）：数量步进（1 起步，不超过库存；加购与立即购买都用它）。 */
  onQtyMinus() {
    this.setData({ qty: stepQty(this.data.qty, -1, this.data.product?.stock ?? null) });
  },

  onQtyPlus() {
    this.setData({ qty: stepQty(this.data.qty, 1, this.data.product?.stock ?? null) });
  },

  onBuyNow() {
    const item = buyNowItem(this.data.product, this.productId, this.data.qty);
    if (item === null) return;
    // 连点守卫（审查 2026-10-09）：navigateTo 是异步的，双击会压入两个结算页、埋点也记两次
    const now = Date.now();
    if (!acceptAddTap(this.lastBuyAt, now)) return;
    this.lastBuyAt = now;
    app.globalData.buyNow = item;
    wxApi.navigateTo({ url: CHECKOUT_BUY_NOW });
  },

  /** 分享卡片（剩余清单 4-4）：标题 = 商品名，路径只带商品 id。 */
  onShareAppMessage() {
    return shareCard(this.data.product, this.productId);
  },
});
