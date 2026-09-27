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
 * @why 刻意**没有"加入购物车 / 立即购买"按钮**：购物车与结算未落地（I2 后续单元），
 *      放一个点了没反应的按钮 = "看起来能用、实际是坏的"。购买动作落地时在这里加
 *      `ws-button`，连点防线由组件承担（页面不写守卫，@see pages/home/index.js 同一条）。
 *
 * @limitation 一：**无分享**（`onShareAppMessage`）——分享出去的小程序卡片需要
 *              真实域名与 AppID 才有意义，骨架期加了也只能在开发者工具里看。
 * @limitation 二：轮播用原生 `swiper`，**没有**指示器自定义样式——默认圆点即可，
 *              为一个还没定版的页面先做指示器属于提前设计。
 *
 * @see ./index.vm.js（视图逻辑真源）；../home/index.vm.js（导航意图真源）
 */
import { detailView } from './index.vm.js';
import { errorMessage } from '../../utils/error-text.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

Page({
  data: {
    /** vm `detailView` 的输出；null = 还没拿到数据（wxml 显示加载态）。 */
    product: null,
    loading: false,
    /** 错误文案（空串 = 无错误）。缺 id / 40401（下架或不存在）都会落到这里。 */
    error: '',
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
      this.setData({ product: null, error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },
});
