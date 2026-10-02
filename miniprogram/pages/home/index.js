/**
 * 职责：首页薄壳（I2 第一个业务页）——生命周期取数 → 调 vm → `setData` / 按意图跳转。
 *
 * ⚠️ 本文件**刻意薄**：所有"视图长什么样"的判断都在 `index.vm.js`（纯函数，24 条单测）。
 *    这里只允许出现三类代码：① 生命周期与取数；② `setData`；③ 宿主能力调用（走 wx-api）。
 *    在这里写业务判断 = 逻辑回到没有测试的地方（@see index.vm.js 文件头 @why、CLAUDE.md 约束十一）。
 *
 * @why 首页刻意**没有 Banner 段**（用户 2026-09-26 拍板"接受无 Banner 版"）：
 *      后端 `GET /home` 尚未实现（契约 0.6.0 里它没有 `x-implemented`），前端接一个不存在的端点
 *      等于"看起来能用、实际是坏的"——那比明确没有更贵。分类项直接来自契约 `/products`
 *      的 category 枚举（vm 里的 `CATEGORIES`，与契约文本有双向比对守着），不依赖 `/home`。
 *
 * @why 商品卡的跳转**只拿意图、不写判断**（`intentForProduct`）：vm 返回 `{go:'detail', id}`，
 *      这里只负责"拼路径 + 调宿主"。@why 路径常量 `DETAIL_PAGE` 落在本文件而不是 vm：
 *      vm 不认识页面路径，才能在 Node 里被测（约束十一的硬规则④不发请求、③不做 IO 同源）。
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
import { errorMessage } from '../../utils/error-text.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { createWxApi } from '../../utils/wx-api.js';
import {
  cartLabel,
  categoryTabs,
  intentForProduct,
  listQuery,
  mergeCards,
  nextPage,
  productCards,
} from './index.vm.js';
import { newTraceId } from '../../utils/trace.js';
import { setActiveTab } from '../../utils/tabs.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发，多建一个实例没有成本）。 */
const wxApi = createWxApi();

/** 商品详情页路径（跳转路径只在这一处出现；vm 只给意图，不认识路径）。 */
const DETAIL_PAGE = '/pages/detail/index';

/**
 * 购物车页路径（S5 起是 tab 页，跳转走 `switchTab`）。
 * @why 路径只在这一处出现（vm 只给意图，不认识路径——约束十一）。
 * @why S5 之后它是 tab 页：**不能再带 query**（`switchTab` 会忽略参数），
 *      这点与 `DETAIL_PAGE` 完全不同，别把 navigateTo 的习惯带过来。
 */
const CART_PAGE = '/pages/cart/index';

/**
 * 「我的」页路径（S5 起是 tab 页，跳转走 `switchTab`）。
 * @why 它是**地址 / 法务**两个页的入口——那两个页不在 tabBar 上，只能从这里进。
 *      ⚠️ 订单已随 S5 升为独立 tab（底部直达），不再只靠本页进。
 */
const USER_PAGE = '/pages/user/index';

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
    /** 购物车入口文案（vm `cartLabel`：带件数角标）。 */
    cartLabel: '',
    /** 错误文案（utils/error-text，真源唯一）；空串 = 无错误。 */
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
  /**
   * 请求序号（B36 / AJ-219）：**每次 reload 领一个新号**（开启一代新列表），
   * `loadMore` 借用当前号、不领新号（R-04 / AJ-226）。
   * 回来的响应号落后于当前号就整份丢弃（含错误与 loading 状态）。
   * @see ../../utils/request-seq.js
   */
  seq: 0,
  /**
   * 切分类 / 搜索的请求在途（R-04 / AJ-226）。在途期间**不发"下一页"**：
   * 此刻屏幕上还是旧列表，"下一页"会用新分类 + 旧页码去取，取回来接在旧列表后面。
   */
  reloading: false,
  /**
   * **已提交**的搜索词（最近一次 `reload` 用的那个）。"下一页"只认它，不读输入框：
   * 输入框里打了字但没点搜索时，列表仍是旧词的结果，翻页必须沿用旧词。
   */
  activeKeyword: '',

  onLoad() {
    // tab 先渲染（本地常量，不需要等网络）——首屏至少有东西可点，而不是一整页白
    this.setData({ tabs: categoryTabs('') });
    this.reload('');
  },

  /**
   * 每次进屏刷新购物车角标。
   * @why 用 onShow 而不是只 onLoad：从详情页加购后**返回**首页不会触发 onLoad
   *      （页面在栈里没销毁），只看 onLoad 的表现是"加了东西，角标还是 0"。
   */
  onShow() {
    this.setData({ cartLabel: cartLabel(app.globalData.cart.count()) });
    // S5：注入底部 tabBar 的高亮（本页是第 0 个 tab）。
    // @why 必须每次进屏都注入：从别的 tab 切回来会触发 onShow 而不触发 onLoad，
    //      只在 onLoad 注的表现是"切回首页、高亮还停在上一页"。
    setActiveTab(this, 'home');
  },

  /**
   * 去购物车。
   * @why S5 之后用 `switchTab` 而不是 `navigateTo`：购物车是 tab 页，
   *      `navigateTo` 到 tab 页会被宿主直接拒绝，表现是"点了没反应"。
   */
  onGoCart() {
    wxApi.switchTab({ url: CART_PAGE });
  },

  /** 去「我的」（地址 / 法务的入口；订单已升为 tab，@see USER_PAGE 注释）。 */
  onGoMine() {
    wxApi.switchTab({ url: USER_PAGE });
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

  /**
   * 点商品卡 → 跳详情。
   * @param {WechatMiniprogram.TouchEvent} e `data-id` 来自 wxml
   */
  onProductTap(e) {
    const id = e?.currentTarget?.dataset?.id;
    const intent = intentForProduct(typeof id === 'string' ? id : '');
    // id 缺失（脏数据）→ 不跳：跳到一个没有 id 的详情页只会白屏
    if (intent === null) return;
    wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(intent.id)}` });
  },

  /** 触底加载下一页。 */
  onReachBottom() {
    this.loadMore();
  },

  /**
   * 错误态里的「重试」（S4：状态块换成 `ws-state-block` 之后才有这个入口）。
   *
   * @why 之前首页失败时只有一行红字，**没有任何可做的动作**——用户只能杀掉小程序重开。
   *      而"重试"在这里是安全的：`reload` 是幂等的整页替换（B36 之后还能安全并发），
   *      它既不建单也不扣款，重复调用没有副作用。
   *      ⚠️ 不是所有"重试"都这么安全：付款类的重试必须走幂等键，那里的重试按钮
   *         要单独论证——这里的判断**不可**照搬到付款页。
   */
  onRetry() {
    void this.reload(this.category);
  },

  /**
   * 重新加载（进入 / 切分类 / 搜索）：一律回到第 1 页并**替换**列表。
   * @param {string} category 当前分类（空串 = 全部）
   */
  async reload(category) {
    const traceId = newTraceId();
    this.traceId = traceId;
    // B36 / AJ-219：领号。切分类/搜索连着点时，只有**最后一次**的结果能落到页面上
    // ⚠️ **只有 reload 领号**（R-04 / AJ-226）：`loadMore` 曾经也领号，于是切分类在途时触底
    //    会把**这次** reload 判成过期——结果被丢弃、loading 永不清。
    //    规则：reload 开启一代新列表（换号），loadMore 属于当前这一代（借号不换号）。
    const seq = (this.seq = nextSeq(this.seq));
    const keyword = this.data.keyword;
    this.reloading = true;
    this.activeKeyword = keyword;
    // 上一代列表的"下一页"（若在途）从此过期：它的标志位由这里统一复位，
    // 过期请求自己的 finally **不再碰**标志位（否则会清掉新一代"下一页"的标志）。
    this.loadingMore = false;
    this.setData({
      loading: true,
      loadingMore: false,
      error: '',
      tabs: categoryTabs(category),
    });
    try {
      const res = await this.fetch(listQuery({ page: 1, category, keyword }), traceId);
      // 已经有更新的请求发出去了 → 这次的结果整份丢弃（含错误）
      if (isStale(seq, this.seq)) return;
      this.apply(res, { reset: true, page: 1 });
    } catch (e) {
      if (isStale(seq, this.seq)) return;
      // ⚠️ 失败时**清空列表**并明示错误：留着旧列表，用户会把它当成
      //    "新分类下的商品"——切到"食品"却还看到厨刀，比报错更伤信任。
      this.page = 0;
      this.loaded = 0;
      this.total = 0;
      this.setData({ cards: [], empty: true, hasMore: false, error: errorMessage(e) });
    } finally {
      // ⚠️ 过期请求不能把 loading 清掉：清了会显示"没在加载"，而新请求其实还在途中
      if (!isStale(seq, this.seq)) {
        this.reloading = false;
        this.setData({ loading: false });
      }
    }
  },

  /** 触底追加下一页（沿用当前 trace，@see traceId 注释）。 */
  async loadMore() {
    // ⚠️ 这**不是**手写连点守卫：`onReachBottom` 没有按钮可挂 ws-button
    //    （page-button-guard 拦的是按钮上的点击，防线收进组件那条规则管不到滚动事件）。
    //    滚动事件的重复触发只能用标志位挡：在途时再触底一次，会发出两个相同的
    //    第 N+1 页请求，列表里出现重复商品且不报错。
    // 切分类 / 搜索在途时不翻页（@see `reloading` 字段注释）
    if (this.reloading || this.loadingMore) return;
    const next = nextPage({ page: this.page, loaded: this.loaded, total: this.total });
    if (next === null) return;
    this.loadingMore = true;
    // B36 / AJ-219：**切了分类之后**还在途中的"下一页"请求必须被丢弃，
    // 否则它会把上一个分类的第 2 页追加到新分类的列表里（且不报错）。
    // ⚠️ 这里**借用当前号、不领新号**（R-04 / AJ-226，理由见 reload）：
    //    reload 换号 ⇒ 本请求过期；本请求不换号 ⇒ 不会反过来把 reload 判过期。
    const seq = this.seq;
    this.setData({ loadingMore: true });
    try {
      const res = await this.fetch(
        // 关键词用**已提交**的那个，不读输入框（@see `activeKeyword` 字段注释）
        listQuery({ page: next, category: this.category, keyword: this.activeKeyword }),
        this.traceId,
      );
      if (isStale(seq, this.seq)) return;
      this.apply(res, { reset: false, page: next });
    } catch (e) {
      if (isStale(seq, this.seq)) return;
      // 追加失败**不清列表**（已加载的商品还在），只提示；用户再触底会自然重试
      this.setData({ error: errorMessage(e) });
    } finally {
      // ⚠️ 过期的"下一页"**两个标志都不碰**：reload 已经把它们复位了，
      //    而此刻实例标志可能属于新一代的"下一页"——清掉它会让同一页被发两次。
      if (!isStale(seq, this.seq)) {
        this.loadingMore = false;
        this.setData({ loadingMore: false });
      }
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
