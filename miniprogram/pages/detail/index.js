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
 * @see ./index.vm.js（视图逻辑真源）；../home/index.vm.js（导航意图真源）
 */
import { buyNowItem, detailView, shareCard } from './index.vm.js';
import { errorFields } from '../../utils/error-text.js';
import { createWxApi } from '../../utils/wx-api.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发）。 */
const wxApi = createWxApi();

/**
 * 购物车页路径（跳转路径只在这一处出现）。
 * @why S5 之后它是 tab 页，跳转**必须**走 `switchTab`（`navigateTo` 会被宿主拒绝，
 *      表现是"点了没反应"，日志里只有一行宿主文案）。
 */
const CART_PAGE = '/pages/cart/index';
/** 结算页（立即购买带 mode=buynow，剩余清单 4-4）。 */
const CHECKOUT_BUY_NOW = '/pages/checkout/index?mode=buynow';

Page({
  data: {
    /** vm `detailView` 的输出；null = 还没拿到数据（wxml 显示加载态）。 */
    product: null,
    loading: false,
    /** 错误文案（空串 = 无错误）。缺 id / 40401（下架或不存在）都会落到这里。 */
    error: '',
    /** true = 本次加购已成功（页内提示，不弹 toast——又一个宿主 API 不值得登记）。 */
    added: false,
  },

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
      this.setData({ error: '缺少商品 id' });
      return;
    }
    this.load();
  },

  /** 取详情。失败**清空商品**并明示错误：留旧数据会让人把别的商品当成这一个。 */
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/products/${this.productId}`,
        traceId: this.traceId,
      });
      this.setData({ product: detailView(res) });
    } catch (e) {
      this.setData({ product: null, ...errorFields(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 加入购物车（qty=1；改数量在购物车页做）。
   * @why 快照信息（title/image/priceJpy）由这里备好交给 cart-store：
   *      购物车是**本地**状态，离线也要能看到加过什么；而快照价**不许**用来算钱
   *      （cart-store.js @limitation 一）。
   */
  onAddToCart() {
    const p = this.data.product;
    if (p === null || p.soldOut) return;
    if (this.productId === '') return;
    app.globalData.cart.add({
      productId: this.productId,
      qty: 1,
      title: p.title,
      image: p.images[0] ?? '',
      priceJpy: p.priceJpy,
    });
    // ⚠️ 只提示、不跳走：加购后自动跳购物车会打断"继续逛"——用户自己点"去购物车"
    this.setData({ added: true });
  },

  /**
   * 去购物车（加购提示里的入口）。
   * @why S5 之后用 `switchTab`：购物车是 tab 页。
   *      ⚠️ 代价是**回不到本页**（switchTab 会关掉所有非 tab 页）——
   *      但"去购物车"本来就是"我逛完了"的意思，返回需求由左上角返回键在
   *      进购物车**之前**满足，进之后不再需要。
   */
  onGoCart() {
    wxApi.switchTab({ url: CART_PAGE });
  },

  /** 立即购买（剩余清单 4-4）：只结这一件，不进购物车。 */
  onBuyNow() {
    const item = buyNowItem(this.data.product, this.productId);
    if (item === null) return;
    app.globalData.buyNow = item;
    wxApi.navigateTo({ url: CHECKOUT_BUY_NOW });
  },

  /** 分享卡片（剩余清单 4-4）：标题 = 商品名，路径只带商品 id。 */
  onShareAppMessage() {
    return shareCard(this.data.product, this.productId);
  },
});
