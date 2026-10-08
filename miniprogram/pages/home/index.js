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
 * @limitation 一：**没有下拉刷新**。切分类 / 搜索已经覆盖"重新拉一遍"的场景（对标分析 §4：首页不做）。
 *              `stopPullDownRefresh` 已随 M-04 在 wx-api 登记（订单列表 / 详情在用）；
 *              真要加时：本页 json 开关 + handler（参照 pages/order/index.js），不动 vm。
 * @limitation 二：`page / loaded / total / category / traceId` 放在 **this 上而不是 data**：
 *              它们不参与渲染，进 data 只会让每次 `setData` 多拷贝一遍、多一次 diff。
 *              ⚠️ 代价是它们**不是响应式的**——wxml 读不到；若哪天要把"第几页"显示出来，
 *              必须把它搬进 data，而不是在 wxml 里读 this。
 * @limitation 三：`loadingMore` 是实例标志位而不是 data（见 `loadMore` 内注释）。
 *
 * @see ./index.vm.js（视图逻辑真源）；../../utils/request.js（错误形状：ApiError{code,message}）；
 *      ../../utils/trace.js（trace_id 串联）；contracts/api-contract.yaml（ProductCard 形状）
 */
import { errorFields } from '../../utils/error-text.js';
import { isStale, nextSeq } from '../../utils/request-seq.js';
import { createWxApi } from '../../utils/wx-api.js';
import {
  bannerAt,
  bannerSlides,
  categoryTabs,
  intentForBanner,
  intentForProduct,
  listQuery,
  mergeCards,
  nextPage,
  productCards,
} from './index.vm.js';
import { newTraceId } from '../../utils/trace.js';
import { setActiveTab, setCartBadge } from '../../utils/tabs.js';
import { track } from '../../utils/beacon.js';

const app = getApp();

/** 页面级宿主入口（wx-api 是无状态转发，多建一个实例没有成本）。 */
const wxApi = createWxApi();

/** 商品详情页路径（跳转路径只在这一处出现；vm 只给意图，不认识路径）。 */
const DETAIL_PAGE = '/pages/detail/index';

Page({
  data: {
    /** 分类 tab（vm `categoryTabs` 的输出，含 active 标记）。 */
    tabs: [],
    /** 首页轮播（vm `bannerSlides` 的输出）；空数组 = 整个轮播段不渲染。 */
    slides: [],
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
  /**
   * `GET /home` 下发的分类清单（不参与渲染，@see @limitation 二）。
   * @why 供 `categoryTabs` 与 `intentForBanner` 共用：tab 以它为准，
   *      banner 的"跳分类"也只认它里面的 key——两处共用同一份，才不会出现
   *      "tab 上有这个分类、banner 点下去却不跳"。
   */
  homeCategories: [],
  /**
   * `GET /home` 的 **`banners` 原始数组**（不参与渲染）。
   * @why 轮播渲染只需要 `{id, image}`（vm `bannerSlides` 的输出），但点击时要按
   *      `link_type` / `link_id` 决定去哪——那两个字段**不在**渲染数据里。
   *      存原始数组而不是"再从渲染数据反查"，是因为反查要靠 index 对齐，
   *      而 `bannerSlides` 会**跳过**没有 image 的条目——index 一旦错位，
   *      点第 2 张会跳到第 3 张的链接，且不报错。
   */
  banners: [],
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
    // tab 先渲染（本地常量兜底，不需要等网络）——首屏至少有东西可点，而不是一整页白
    this.setData({ tabs: categoryTabs(this.homeCategories, '') });
    // 轮播与商品流**并发**拉取、互不等待（@see loadHome @why）
    void this.loadHome();
    this.reload('');
  },

  /**
   * 每次进屏刷新 tabBar 高亮与购物车角标。
   * @why 用 onShow 而不是只 onLoad：从详情页加购后**返回**首页不会触发 onLoad
   *      （页面在栈里没销毁），只看 onLoad 的表现是"加了东西，角标还是 0"。
   * @why M-14（AJ-406）：首页原有"购物车 · N""我的"两个按钮与底部 tabBar **重复**，已去掉；
   *      件数角标改由 tabBar 购物车格显示（utils/tabs.js setCartBadge），首屏多出一行商品位。
   */
  onShow() {
    track(app, 'page_view', { page: 'home' }); // M-21 页面曝光
    // S5：注入底部 tabBar 的高亮（本页是第 0 个 tab）。
    // @why 必须每次进屏都注入：从别的 tab 切回来会触发 onShow 而不触发 onLoad，
    //      只在 onLoad 注的表现是"切回首页、高亮还停在上一页"。
    setActiveTab(this, 'home');
    setCartBadge(this, app.globalData.cart);
  },

  /**
   * 拉 `GET /home`（轮播 + 分类清单）。**只在进屏时拉一次**，切分类 / 搜索不重拉。
   *
   * @why 与商品流**并发且互不等待**：等 `/home` 回来再拉 `/products`，首屏就是两次串行往返；
   *      而两块数据之间没有依赖（banner 不影响列表怎么取数）。
   * @why 失败**静默**（轮播段不渲染、分类用本地常量兜底），不 setData error：
   *      轮播是首页的**装饰层**，商品流才是正事——让一次 `/home` 失败把整页变成错误态，
   *      是把装饰性内容的失败放大成整页失败。
   *      ⚠️ 而且 `/home` 失败的原因（DB 挂了）大概率会让 `/products` 也失败，
   *      那时商品流自己会报错，不需要轮播再报一次——两条错误叠在一起，
   *      用户只看到"首页坏了"，反而更难判断坏在哪。
   * @limitation 静默的代价：**运营侧看不见"轮播取不到"**——它与"今天没配 banner"
   *      在页面上是同一个样子。这份可见性由**服务端**承担（`/home` 失败是 5xx，
   *      走服务端日志与告警），不靠小程序；服务端因此也刻意**不**把故障降级成空数组
   *      （@see server/src/app/home-routes.ts @limitation 一）。两端分工：
   *      服务端不瞒故障，前端不放大故障。
   */
  async loadHome() {
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/home`,
        traceId: newTraceId(),
      });
      const categories = Array.isArray(res?.categories) ? res.categories : [];
      this.homeCategories = categories;
      this.banners = Array.isArray(res?.banners) ? res.banners : [];
      this.setData({
        slides: bannerSlides(res?.banners),
        // ⚠️ 用**当前**分类重算 tab：`/home` 可能在用户已经切过分类之后才回来，
        //    这里传空会让高亮跳回「全部」（表现为"我刚点了美妆，它自己跳回去了"）。
        tabs: categoryTabs(categories, this.category),
      });
    } catch (e) {
      // 静默（@why 见上）。`void e` 而不是空块：空 catch 会被 lint 判为"吞错"，
      // 而这里是有理由的降级——留一个显式语句，逼后来者先读上面那段再改。
      void e;
    }
  },

  /**
   * 点轮播图 → 按 `link_type` 去商品详情，或切到某个分类。
   * @param {WechatMiniprogram.TouchEvent} e `data-index` 来自 wxml
   */
  onBannerTap(e) {
    const index = Number(e?.currentTarget?.dataset?.index);
    // ⚠️ 必须走 `bannerAt`（按"可见 banner"取），不能按渲染下标去索引未过滤的那份数组：
    //    `slides` 是过滤掉无图 / 无 id 条目之后的子序列，两个数组的下标只在一条都没被
    //    跳过时才相等。只要有一张 banner 没图，后面每张整体前移一位 ⇒ 点第 2 张跳到
    //    第 3 张的链接（图是对的，只有链接错，没有任何一方报错）。
    const banner = bannerAt(this.banners, index);
    const intent = intentForBanner(banner, this.homeCategories);
    // 不可跳（link_type=none / 目标缺失 / 分类不在清单里）→ 点了不动，不跳空页
    if (intent === null) return;
    if (intent.go === 'detail') {
      wxApi.navigateTo({ url: `${DETAIL_PAGE}?id=${encodeURIComponent(intent.id)}` });
      return;
    }
    // 跳分类 = **切走当前搜索词**：轮播说的是"去逛这个分类"，
    // 而不是"在当前搜索结果里换个分类"——带着旧词会把用户带到一个他没要过的组合
    if (intent.key === this.category) return;
    this.setData({ keyword: '' });
    this.category = intent.key;
    this.reload(intent.key);
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
      tabs: categoryTabs(this.homeCategories, category),
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
      this.setData({ cards: [], empty: true, hasMore: false, ...errorFields(e) });
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
      this.setData({ ...errorFields(e) });
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
