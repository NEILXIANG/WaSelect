/**
 * 职责：首页薄壳（I2 第一个业务页）——生命周期取数 → 调 vm → `setData` / 按意图跳转。
 *
 * ⚠️ 本文件**刻意薄**：所有"视图长什么样"的判断都在 `index.vm.js`（纯函数，26 条单测）。
 *    这里只允许出现三类代码：① 生命周期与取数；② `setData`；③ 宿主能力调用（走 wx-api）。
 *    在这里写业务判断 = 逻辑回到没有测试的地方（@see index.vm.js 文件头 @why、CLAUDE.md 约束十一）。
 *
 * @why 首页刻意**没有 Banner 段**（用户 2026-09-26 拍板"接受无 Banner 版"）：
 *      后端 `GET /home` 尚未实现（契约 0.6.0 里它没有 `x-implemented`），前端接一个不存在的端点
 *      等于"看起来能用、实际是坏的"——那比明确没有更贵。分类项直接来自契约 `/products`
 *      的 category 枚举（vm 里的 `CATEGORIES`，与契约文本有双向比对守着），不依赖 `/home`。
 *
 * @why 商品卡**当前不可点**：目标页 `pages/detail` 尚未落地，跳一个不存在的页面
 *      在真机上是"点了报 page not found"——同一种"看起来能用、实际是坏的"。
 *      vm 的 `intentForProduct` 已就位且被单测钉住，详情页单元接线时只需给 wxml
 *      加 `bindtap` + 本文件加一个 handler，vm 与它的测试一行不用动。
 *
 * @limitation 一：**没有下拉刷新**。`onPullDownRefresh` 要配 `wx.stopPullDownRefresh`
 *              （又一个宿主能力要登记）+ json 开 `enablePullDownRefresh`，而切分类 / 搜索
 *              已经覆盖"重新拉一遍"的场景——为一个等价入口多登记一个 API 属于提前做。
 *              真要加时：wx-api 登记 + 本页 json 开关 + handler，三步都不动 vm。
 * @limitation 二：`page / loaded / total / category / traceId` 放在 **this 上而不是 data**：
 *              它们不参与渲染，进 data 只会让每次 `setData` 多拷贝一遍、多一次 diff。
 *              ⚠️ 代价是它们**不是响应式的**——wxml 读不到；若哪天要把"第几页"显示出来，
 *              必须把它搬进 data，而不是在 wxml 里读 this。
 * @limitation 三：`loadingMore` 是实例标志位而不是 data（见 `loadMore` 内注释）。
 *
 * @see ./index.vm.js（视图逻辑真源）；../../utils/request.js（错误形状：ApiError{code,message}）；
 *      ../../utils/trace.js（trace_id 串联）；contracts/api-contract.yaml（ProductCard 形状）
 */
import {
  categoryTabs,
  errorMessage,
  listQuery,
  mergeCards,
  nextPage,
  productCards,
} from './index.vm.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

Page({
  data: {
    /** 分类 tab（vm `categoryTabs` 的输出，含 active 标记）。 */
    tabs: [],
    /** 商品卡（vm `productCards` 的输出）。 */
    cards: [],
    /** 搜索框内容（受控：只存值，触发请求在 `onSearch`）。 */
    keyword: '',
    /** 首屏加载中（触底加载是另一个标志，二者不共用——共用会让首屏转圈盖住已加载的列表）。 */
    loading: false,
    /** 触底加载中（wxml 用它在列表底部显示"加载中…"）。 */
    loadingMore: false,
    /** 列表为空（区分"没有商品"和"加载失败"——两者在真机上长得一样就没有人信这个页了）。 */
    empty: false,
    /** 是否还有下一页（vm `nextPage` 的布尔化，控制底部提示与触底行为）。 */
    hasMore: false,
    /** 错误文案（vm `errorMessage`；空串 = 无错误）。 */
    error: '',
  },

  /**
   * 请求游标（不参与渲染，见 @limitation 二）。
   * ⚠️ 必须在 onLoad 前就有默认值：Page 的自定义属性在实例化时就是这里的字面量。
   */
  page: 0,
  loaded: 0,
  total: 0,
  category: '',
  /** 本次浏览的 trace_id：进入 / 切分类 / 搜索各开一条新链，触底加载**沿用**同一条
   *  （同一轮浏览的分页是同一次用户操作，拆开会让服务端日志断成 N 截）。 */
  traceId: '',

  onLoad() {
    // tab 先渲染（本地常量，不需要等网络）——首屏至少有东西可点，而不是一整页白
    this.setData({ tabs: categoryTabs('') });
    this.reload('');
  },

  /**
   * 切分类。
   * @param {WechatMiniprogram.TouchEvent} e `data-key` 来自 wxml（空串 = 全部）
   */
  onCategoryTap(e) {
    const key =
      typeof e?.currentTarget?.dataset?.key === 'string' ? e.currentTarget.dataset.key : '';
    // 点已选中的分类不做任何事：重复请求的结果是列表闪一下 + 白花一次流量
    if (key === this.category) return;
    this.category = key;
    this.reload(key);
  },

  /** 搜索框输入（只存值；请求由确认键 / 搜索按钮触发，逐字符发请求是灾难）。 */
  onSearchInput(e) {
    this.setData({ keyword: typeof e?.detail?.value === 'string' ? e.detail.value : '' });
  },

  /** 触发搜索（键盘确认键与搜索按钮都到这）。 */
  onSearch() {
    this.reload(this.category);
  },

  /** 触底加载下一页。 */
  onReachBottom() {
    this.loadMore();
  },

  /**
   * 重新加载（进入 / 切分类 / 搜索）：一律回到第 1 页并**替换**列表。
   * @param {string} category 当前分类（空串 = 全部）
   */
  async reload(category) {
    const traceId = newTraceId();
    this.traceId = traceId;
    this.setData({ loading: true, error: '', tabs: categoryTabs(category) });
    try {
      const res = await this.fetch(
        listQuery({ page: 1, category, keyword: this.data.keyword }),
        traceId,
      );
      this.apply(res, { reset: true, page: 1 });
    } catch (e) {
      // ⚠️ 失败时**清空列表**并明示错误：留着旧列表，用户会把它当成
      //    "新分类下的商品"——切到"食品"却还看到厨刀，比报错更伤信任。
      this.page = 0;
      this.loaded = 0;
      this.total = 0;
      this.setData({ cards: [], empty: true, hasMore: false, error: errorMessage(e) });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 触底追加下一页（沿用当前 trace，@see traceId 注释）。 */
  async loadMore() {
    // ⚠️ 这**不是**手写连点守卫：`onReachBottom` 没有按钮可挂 ws-button
    //    （page-button-guard 拦的是按钮上的点击，防线收进组件那条规则管不到滚动事件）。
    //    滚动事件的重复触发只能用标志位挡：在途时再触底一次，会发出两个相同的
    //    第 N+1 页请求，列表里出现重复商品且不报错。
    if (this.loadingMore) return;
    const next = nextPage({ page: this.page, loaded: this.loaded, total: this.total });
    if (next === null) return;
    this.loadingMore = true;
    this.setData({ loadingMore: true });
    try {
      const res = await this.fetch(
        listQuery({ page: next, category: this.category, keyword: this.data.keyword }),
        this.traceId,
      );
      this.apply(res, { reset: false, page: next });
    } catch (e) {
      // 追加失败**不清列表**（已加载的商品还在），只提示；用户再触底会自然重试
      this.setData({ error: errorMessage(e) });
    } finally {
      this.loadingMore = false;
      this.setData({ loadingMore: false });
    }
  },

  /**
   * 把响应变成视图数据——**所有判断都在 vm**，这里只做搬运。
   * @param {unknown} res `GET /products` 的响应体
   * @param {{reset: boolean, page: number}} o reset=true 替换（首屏 / 切分类 / 搜索）
   */
  apply(res, { reset, page }) {
    const incoming = productCards(res?.items);
    const cards = mergeCards(this.data.cards, incoming, reset);
    const loaded = reset ? incoming.length : cards.length;
    this.page = page;
    this.loaded = loaded;
    this.total = res?.total;
    this.setData({
      cards,
      empty: cards.length === 0,
      // `nextPage` 返回 null（没有更多）时置 false；total 缺失 / 非整数同样是 false
      hasMore: nextPage({ page, loaded, total: this.total }) !== null,
    });
  },

  /**
   * `GET /products`。
   * @param {ReturnType<typeof listQuery>} query vm 组好的查询参数
   * @param {string} traceId
   */
  fetch(query, traceId) {
    return app.globalData.api({
      url: `${app.globalData.apiBase}/api/v1/products`,
      data: query,
      traceId,
    });
  },
});
