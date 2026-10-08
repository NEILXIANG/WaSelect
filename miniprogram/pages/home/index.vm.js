/**
 * 职责：首页（`pages/home`）的**视图逻辑**——纯函数集合，不读宿主、不做 IO、不发请求。
 *
 * @why 它存在是为了让约束一在小程序端**真的成立**（CLAUDE.md 约束十一）：
 *      页面逻辑写在 `Page({...})` 的方法里时，唯一验证方式是"真机点一下"——
 *      本项目没有小程序组件测试框架，于是"无绿灯不前进"在前端形同虚设。
 *      抽成纯函数后，列表加工、分类切换、分页边界、错误文案都能被单测钉住，
 *      真机只剩"长得对不对"这一件事。
 *
 * @why 导航**只返回意图**（`{go:'detail', id}`），不调 `wx.navigateTo`：
 *      跳转是副作用，留在 `index.js`（宿主能力走 `utils/wx-api.ts`）。
 *      这样本文件能被 Node 直接 import 测试，也避免"页面路径"混进展示逻辑。
 *
 * @limitation 一：**分类展示名落在前端这一处**（`CATEGORY_LABELS`）。
 *              后端 `GET /home` 的 `categories` 与 `GET /products` 的 `category` 都**只给 key**
 *              （契约现状，无 label 字段），所以展示名目前只能由前端持有。
 *              ⚠️ `/home` 下发了一个前端不认识的新分类时，展示名**回落到 key 本身**
 *              （`CATEGORY_LABELS[key] ?? key`）——宁可显示一串英文 key，
 *              也不要让它从分类栏里**消失**：消失的话运营会以为"配了没生效"，
 *              而实际上它只是缺一个展示名。
 *              @why 仍然集中在一处而不是写进 wxml：写进 wxml 就是四个 tab 各写一遍，
 *              "这个分类忘了译"不会有任何报错。后端给了 label 之后改这里一处即可。
 *              @tradeoff 与"UI 不写死"（约束五）的边界：这是**文案**，不是口径
 *              （不是金额 / 税率 / 国家 / 承运商），且当前没有第二个来源——
 *              宁可留一处写明的欠账，也不要假装它不存在。
 * @limitation 二：**占位图是本地资源，不是商品图**（用户 2026-09-26 拍板"占位图先跑通，不等 R2"）。
 *              真图要等云存储与 CDN（风险 R2），在那之前 `image` 缺失或为空一律回落到
 *              `PLACEHOLDER_IMAGE`。@why 不留给空 src：`<image>` 拿到空 src 会刷控制台警告并留白，
 *              而"留白"和"这个商品没图"在真机上看不出区别——排查时会往图片服务方向查，而不是查数据。
 * @limitation 三：副行展示价**缺哪个币就不显示哪个**（后端 fx 缺失时 `display` 会少键，AJ-108 降级口径），
 *              两个都没有 → 空串（wxml 用 `wx:if` 整行隐藏）。
 *              ⚠️ 非整数也一并跳过而不抛：`formatUsdCents` 对非整数是抛错的（@see price-format.js
 *              @limitation 二），但那是**服务端**该炸的地方；在浏览列表里抛会让整列渲染失败，
 *              代价远大于少一行参考价。这里的选择是"降级"，不是"吞错"——整列空白比少一行贵。
 *
 * @see ../../utils/price-format.js（金额文案真源）；../../utils/wx-api.ts（宿主能力唯一入口）；
 *      contracts/api-contract.yaml（ProductCard / Display / ImageSet 形状）
 */

import { displaySubLine } from '../../utils/price-format.js';
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';

/**
 * 契约 `/products` 的 category 枚举。
 * @why 与服务端 `PRODUCT_CATEGORIES` 是**同一份词汇表的两处副本**——
 *      小程序不能 import server 代码（不同构建产物），所以只能各持一份；
 *      两处漂移的表现是"前端有个分类点了永远是空的"，且不报错。
 *      由 `index.vm.unit.test.ts` 里与契约文本的双向比对守着（缺一即红）。
 */
export const CATEGORIES = ['beauty', 'daily', 'kitchen', 'food'];

/** 分类 key → 展示名。@see @limitation 一 */
export const CATEGORY_LABELS = {
  beauty: '美妆护肤',
  daily: '生活百货',
  kitchen: '厨房餐具',
  food: '食品',
};

/** 每页条数（契约 `/products` 的 size 默认值；上限 50，见契约 `maximum`）。 */
export const PAGE_SIZE = 20;

/** 取"去空格后的字符串"；非字符串一律当空——`123` 不是分类、`null` 不是关键词。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 商品图：契约 ImageSet 取 `card`；缺/空/形态不对 → 占位图（真源 utils/placeholder.js）。 */
function imageOf(image) {
  const src = imageUrl(image);
  return src === '' ? PLACEHOLDER_IMAGE : src;
}

/**
 * 分类 tab（`全部` + 各分类）。
 * @param {unknown} [categories] `GET /home` 下发的分类清单；空 / 非数组 → **回落到本地 `CATEGORIES`**。
 *        @why 兜底而不是"等 `/home` 回来再渲染"：等的话首屏会先只显示一个「全部」、
 *        再补出四个分类——分类栏**往上顶一下**是用户能看见的抖动，而分类是四个常量，
 *        没有任何理由让它们等一次网络往返。
 *        @why 但 `/home` 回来后**以它为准**：否则 `categories` 就是没人消费的死数据，
 *        将来服务端加了第五个分类，前端会一直看不见（且不报错）。
 * @param {unknown} [active] 当前选中的分类 key；空 / 非字符串 = 未选（= 全部）。
 *        ⚠️ 类型是 `unknown` 而不是 `string`：它来自 wxml 的 `data-key`，取不到时是 `undefined`，
 *        类型上收紧成 string 会让"必须判空"这件事消失，而那正是要守的行为。
 * @returns {Array<{key: string, label: string, active: boolean}>}
 */
export function categoryTabs(categories, active) {
  const cur = text(active);
  const fromServer = Array.isArray(categories)
    ? categories.filter((k) => typeof k === 'string' && k !== '')
    : [];
  // 服务端没给（首屏 / /home 失败）→ 本地常量兜底（@see 上一条 @why）
  const keys = fromServer.length > 0 ? fromServer : CATEGORIES;
  return [
    { key: '', label: '全部', active: cur === '' },
    ...keys.map((key) => ({ key, label: CATEGORY_LABELS[key] ?? key, active: key === cur })),
  ];
}

/**
 * `GET /products` 的 items → 卡片视图数据（S4 起喂 `ws-pick-card`）。
 * @param {unknown} items 契约 `ProductCard[]`
 * @returns {Array<{id: string, title: string, image: string, priceJpy: unknown, subPrice: string,
 *                  soldOut: boolean, stock: number, maker: string, why: string, tags: string[]}>}
 * @why `priceJpy` **原样透传、不做任何兜底**：`ws-price` 对非整数金额是抛错的
 *      （组件 @limitation 一：漏传被补成 0 会显示 `0 円`，而 `0 円` 会被读成"免费"）。
 *      在这里补 0 就等于把那道防线拆掉。
 *
 * @why `why` / `maker` **缺失时给空串而不是 null**：它们是**直接进组件属性**的字符串，
 *      组件对空串的处理是"这一块不渲染"（降级），对 null 的处理在小程序里是
 *      "属性变成 null 字符串"——后者会把卡片上渲染出字面量 "null"。
 *      ⚠️ 这正是服务端对这两个字段"整键省略"的原因：省略 → 前端这里补空串 → 组件降级，
 *      三段各司其职，任何一段想"顺便兜底"都会把脏数据洗白。
 * @why `stock` 缺/非整数 → **-1** 而不是 0：0 在组件里是"售罄"的语义，
 *      "不知道库存"与"没有库存"必须可区分（给 0 会让所有商品都显示售罄）。
 */
export function productCards(items) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : '',
      title: typeof p.title === 'string' ? p.title : '',
      image: imageOf(p.image),
      priceJpy: p.price_jpy,
      subPrice: displaySubLine(p.display),
      soldOut: Number(p.stock) === 0,
      stock: Number.isInteger(p.stock) ? p.stock : -1,
      maker: typeof p.maker === 'string' ? p.maker : '',
      why: typeof p.why === 'string' ? p.why : '',
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : [],
    };
  });
}

/**
 * 组装 `GET /products` 的查询参数。
 * @why 空的 `category` / `keyword` **省略而不是传空串**：带上 `keyword=` 会让服务端
 *      收到"关键词是空字符串"，与"没有关键词"是两种语义（前者可能匹配不到任何行），
 *      而这种差异在真机上表现为"切回全部却什么都搜不到"，且没有任何报错。
 * @param {object} args
 * @param {unknown} [args.page] 页码；非正整数一律归一成 1（服务端对 page<1 是 40001）
 * @param {unknown} [args.category] 分类 key；空 / 非字符串 → 省略
 * @param {unknown} [args.keyword] 搜索词；去空格后为空 → 省略；超长截断（`searchKeyword`，P2-32）
 * @param {number} [args.size] 每页条数，默认 `PAGE_SIZE`（上限 50 由服务端守）
 */
export function listQuery({ page, category, keyword, size = PAGE_SIZE }) {
  const q = { page: Number.isInteger(page) && page > 0 ? page : 1, size };
  const c = text(category);
  const k = searchKeyword(keyword);
  if (c !== '') q.category = c;
  if (k !== '') q.keyword = k;
  return q;
}

/**
 * 搜索词长度上限（P2-32）。
 * @why 与 `packages/shared/src/limits.ts` 的 `SEARCH_KEYWORD_MAX_LENGTH` 同值：服务端超限一律 40001，
 *      而小程序 js 引不了 shared 的 ts——这里是第二份真值，由 vm 单测 import shared 比对，漂移即红。
 *      wxml 的 `maxlength="64"` 是第一道（输入时就停住），这里是第二道（粘贴 / 旧数据 / 宿主差异）。
 */
export const SEARCH_KEYWORD_MAX = 64;

/**
 * 输入框原值 → 发给服务端的搜索词：trim 后截断到 `SEARCH_KEYWORD_MAX`（P2-32）。
 * @why 截断而不是拒绝：搜索词是"尽量帮你找"，长出来的尾巴丢掉比弹一个错误更有用；
 *      服务端按 UTF-16 码元（`.length`）判，这里同口径。
 * @why 不切开代理对：截断点落在 emoji 中间会留下半个代理项，`encodeURIComponent` 对它抛 URIError，
 *      表现是"点搜索没反应"。所以落在高位代理项上时再少取一位。
 */
export function searchKeyword(raw) {
  const k = text(raw);
  if (k.length <= SEARCH_KEYWORD_MAX) return k;
  const last = k.charCodeAt(SEARCH_KEYWORD_MAX - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? SEARCH_KEYWORD_MAX - 1 : SEARCH_KEYWORD_MAX;
  return k.slice(0, end);
}

/** 是否还有下一页（触底加载的开关）。`total` 非整数 → 一律 false（宁可不加载，也不要无限刷）。 */
export function hasMore({ loaded, total }) {
  return Number.isInteger(loaded) && Number.isInteger(total) && loaded < total;
}

/** 下一页页码；`null` = 没有更多（调用方据此**不发**请求，避免到底后无限触发触底）。 */
export function nextPage({ page, loaded, total }) {
  return hasMore({ loaded, total }) ? page + 1 : null;
}

/**
 * 合并列表。
 * @param {Array<unknown>} existing 已有卡片
 * @param {Array<unknown>} incoming 本次拉取的卡片
 * @param {boolean} reset true = 替换（切分类 / 搜索 / 下拉刷新）；false = 追加（触底加载）
 * @why 这一个布尔值钉住的是最容易漏的一步：**切了分类却忘记清空**。
 *      它的表现不是报错，而是"列表里混着上一个分类的商品"——用户在首页看到
 *      美妆分类下出现厨刀，只会觉得这个站不靠谱，没人会想到是前端没清列表。
 */
export function mergeCards(existing, incoming, reset) {
  return reset ? incoming : existing.concat(incoming);
}

/**
 * 商品卡的导航意图；id 缺失 → null（跳到一个没有 id 的详情页只会白屏）。
 * @param {unknown} id 商品 id（来自 wxml 的 `data-id`，取不到时是 `undefined`）
 */
export function intentForProduct(id) {
  return typeof id === 'string' && id !== '' ? { go: 'detail', id } : null;
}

/**
 * `GET /home` 的 `banners` → 轮播视图数据。
 * @param {unknown} banners 契约 `Banner[]`
 * @returns {Array<{id: string, image: string}>}
 *
 * @why 没有 `image` 的条目**整条不展示**，且**不回落** `PLACEHOLDER_IMAGE`——
 *      这是全站唯一不回落占位图的图位，理由是语义不同：
 *      占位图说的是"这个商品没图"（@see utils/placeholder.js），
 *      而 banner 缺 `image` 说的是"服务端没配 `IMG_BASE_URL`"（契约口径：未配置时整键省略）。
 *      用占位图顶上，等于把一次**配置故障**洗成"这张 banner 没图"，
 *      排查方向会直奔图床与图片本身，永远查不到 `.env`。
 *      @see ../../../server/src/app/banner-view.ts @limitation 一（服务端的同一条口径）
 * @why **不在这里判 `active` 与起止时间**：服务端 `/home` 已经按**自己的时钟**判过了
 *      （契约：生效判定只在服务端做一次）。前端再判一次就得用**本机时钟**——
 *      时钟偏的用户会看到"该下架的还在 / 该上线的没来"，而这种表现是**随机的**，
 *      没人会往时钟方向查。与 `FxRate.is_current` 同一条口径。
 * @why `id` 缺失也一并跳过：轮播的 `wx:key` 用 id，缺 id 会让列表在插入/删除时
 *      复用错误的节点（表现为"图没换但指示器跳了"）。
 */
/**
 * **会被真正渲染出来**的那几条 banner（原对象，未改形）。
 *
 * @why 它单独存在，是为了让"渲染用的数组"与"点击时按下标取的那一份"**只能是同一份**。
 *      首版里渲染走 `bannerSlides()`（过滤后），点击却取 `this.banners[index]`（未过滤）——
 *      两份数组的下标只在"一条都没被过滤掉"时才相等；
 *      只要有一条 banner 没图（管理端图没传完就先上架，很常见），后面每条整体前移一位，
 *      表现为**点第 2 张跳到第 3 张的链接**——图是对的，只有链接错，没有任何一方报错。
 * @why 放在 vm 里而不是在页面里再存一份"过滤后的数组"：两份数组靠人保持同步，
 *      迟早有一处漏改，而漏改是静默的。这里让**下标解析**也走过滤函数，
 *      从构造上排除错位（不是靠注释提醒"记得同步"）。
 */
export function visibleBanners(banners) {
  if (!Array.isArray(banners)) return [];
  const out = [];
  for (const raw of banners) {
    const b = raw !== null && typeof raw === 'object' ? raw : {};
    const image = typeof b.image === 'string' ? b.image.trim() : '';
    const id = typeof b.id === 'string' || typeof b.id === 'number' ? String(b.id) : '';
    if (image === '' || id === '') continue;
    out.push(b);
  }
  return out;
}

export function bannerSlides(banners) {
  return visibleBanners(banners).map((b) => ({
    id: String(b.id),
    image: String(b.image).trim(),
  }));
}

/**
 * 轮播下标 → banner（`data-index` 来自 `slides`，不是来自未过滤的 `banners`）。
 * @returns 越界 / 下标不是整数 → `undefined`（由调用方决定"点了个寂寞"怎么办）
 */
export function bannerAt(banners, index) {
  if (!Number.isInteger(index)) return undefined;
  const visible = visibleBanners(banners);
  return index >= 0 && index < visible.length ? visible[index] : undefined;
}

/**
 * banner 的导航意图；不可跳 → null（点了没反应好过跳到一个空的详情页）。
 * @param {unknown} banner 契约 `Banner`（`link_type` / `link_id`）
 * @param {unknown} [categories] 当前已知的分类 key 清单（`GET /home` 下发的）
 * @returns {{go: 'detail', id: string} | {go: 'category', key: string} | null}
 *
 * @why `link_type='category'` **只认已知分类**（在 `categories` 里才跳）：
 *      直接拿 `link_id` 去打 `GET /products?category=` 的话，一个不合法的值会拿到 40001，
 *      页面上是"切了分类、列表空了、还有一行错误"——用户被带进了一个错误状态。
 *      不跳虽然也怪，但用户仍停在正常的首页。
 *      @limitation 正解是**服务端在保存 banner 时就校验** `link_id` 是不是合法分类
 *      （那是管理端表单里一条**有提示**的路径）；前端这道只是不把错误放大。
 * @why `link_type='none'` / 认不出的类型 → null：banner 可以只做展示不跳转（契约默认值就是 none）。
 */
export function intentForBanner(banner, categories) {
  const b = banner !== null && typeof banner === 'object' ? banner : {};
  const type = typeof b.link_type === 'string' ? b.link_type : 'none';
  const id = typeof b.link_id === 'string' ? b.link_id.trim() : '';
  if (id === '') return null;
  if (type === 'product') return { go: 'detail', id };
  if (type === 'category') {
    const known = Array.isArray(categories) ? categories.filter((k) => typeof k === 'string') : [];
    return known.includes(id) ? { go: 'category', key: id } : null;
  }
  return null;
}
