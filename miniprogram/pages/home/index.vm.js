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
 * 分类 tab（`全部` + 四个分类）。
 * @param {unknown} [active] 当前选中的分类 key；空 / 非字符串 = 未选（= 全部）。
 *        ⚠️ 类型是 `unknown` 而不是 `string`：它来自 wxml 的 `data-key`，取不到时是 `undefined`，
 *        类型上收紧成 string 会让"必须判空"这件事消失，而那正是要守的行为。
 * @returns {Array<{key: string, label: string, active: boolean}>}
 */
export function categoryTabs(active) {
  const cur = text(active);
  return [
    { key: '', label: '全部', active: cur === '' },
    ...CATEGORIES.map((key) => ({ key, label: CATEGORY_LABELS[key] ?? key, active: key === cur })),
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
 * @param {unknown} [args.keyword] 搜索词；去空格后为空 → 省略
 * @param {number} [args.size] 每页条数，默认 `PAGE_SIZE`（上限 50 由服务端守）
 */
export function listQuery({ page, category, keyword, size = PAGE_SIZE }) {
  const q = { page: Number.isInteger(page) && page > 0 ? page : 1, size };
  const c = text(category);
  const k = text(keyword);
  if (c !== '') q.category = c;
  if (k !== '') q.keyword = k;
  return q;
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
 * 购物车入口文案（带件数角标）。
 * @param {unknown} count `cart-store.count()` 的件数
 * @returns {string} `购物车` / `购物车 · 3`
 * @why 角标由 vm 拼而不是 wxml 里拼：wxml 只适合简单表达式，
 *      "0 件时不显示数字"这种判断散在模板里迟早有人忘；而忘了的表现是
 *      "空车也显示 购物车 · 0"——那是在提醒用户"你什么都没买"，属于多余噪音。
 */
export function cartLabel(count) {
  return Number.isInteger(count) && count > 0 ? `购物车 · ${count}` : '购物车';
}
