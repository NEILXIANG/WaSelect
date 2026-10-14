/**
 * 职责：商品详情页（`pages/detail`）的**视图逻辑**——纯函数，不读宿主、不做 IO、不发请求。
 *
 * @why 与首页 vm 同一条理由（CLAUDE.md 约束十一）：详情页的判断——
 *      "没图给占位"、"描述为空整段隐藏"、"哪些字段给用户看"——
 *      写在 `Page({...})` 里就只剩真机点这一种验证方式。抽出来，24→N 条单测钉住。
 *
 * @why 刻意**不透出**契约里的 `hs_code` / `customs_desc_en` / `compliance_tags`：
 *      它们是**报关合规信息**（D-39/D-42，管理员上架核对用）。给用户看只会制造疑问——
 *      "SPF 是什么？为什么这个商品带 quasi_drug 标签？"——而答案没有一个是用户能用的。
 *      ⚠️ 这是"少显示"，不是"隐藏缺陷"：合规标签决定的是**能不能上架**，上架了就该让用户安心。
 *
 * @limitation 一：原产地的展示名（`JP → 日本`）落在本文件这一处，与首页的分类展示名
 *              同一条欠账（后端契约只给 ISO 码，没有展示名；见 home vm @limitation 一）。
 * @limitation 二：**库存数字不展示**，只给"已售罄"一个布尔态。
 *              @why 精确库存（"还剩 3 件"）是运营手段，会逼着每次改动都同步前后端口径；
 *              MVP 只要回答"能不能买"这一个问题。
 * @limitation 三：`weight_g` 展示成"约 N g"——它是**申报重量**（含包材口径在报价域另有
 *              PACKAGING_WEIGHT_G，D-42），与商品实重本就有差；"约"字是刻意留的余地。
 *
 * @limitation 四（M-03，AJ-405）：购买保障与运输流程是**店铺级**文案，写在本文件常量里；
 *              运输天数**刻意没有**——要等首批 EMS 实测后由服务端配置下发（AJ-402 Q2），
 *              届时加一个可选字段，本文件只多一个"有就显示"的分支。
 *
 * @see ../home/index.vm.js（首页 vm，同一套约束）；../../utils/price-format.js（displaySubLine）；
 *      ../../utils/placeholder.js（占位图真源）；contracts/api-contract.yaml（Product 形状）
 */

import { displaySubLine } from '../../utils/price-format.js';
import { PLACEHOLDER_IMAGE, imageUrl } from '../../utils/placeholder.js';
import { MAX_CART_LINES, MAX_LINE_QTY } from '../../utils/cart-store.js';
import { STOCK_REFUND_NOTE } from '../../utils/order-status.js';
import { cartBadgeText } from '../../utils/tabs.js';

/** 原产地 ISO 码 → 展示名。@see @limitation 一 */
const ORIGIN_LABELS = { JP: '日本' };

/**
 * 价格口径说明（D-32 / D-69②：商品价含美国关税，DDP 由 KK 预缴计入定价；运费按重量单列）。
 * @why 写在 vm 常量而不是 wxml：口径变时改这一处，且被单测钉住（提审前必须项，AJ-176 标注）。
 * @limitation 口径本身是店铺级政策，不随商品变；将来若出现"不含关税"的商品，要改成由契约下发。
 */
// 体验排查 2026-10-14（用户授权代决）：结算页把关税标成「预估」，这里说「含」——两句并列时要说清：含是谁付，预估是数值；差额不向买家另收
export const DUTY_NOTE =
  '价格已含美国关税（关税金额为预估，差额不向你另收），国际运费按重量在结算时计算';

/**
 * 运输流程分段说明（M-03，AJ-405）——**不写天数**。
 * @why 每一段只陈述"谁在哪一步做什么"，可核验：日本采购（STOCK_REFUND_NOTE 同一事实）、从日本发出
 *      （MVP 只卖日本原产、日本发货，D-43）、国际运输、清关派送（D-32 DDP：关税已含在价内，买家无需清关动作，对标分析 §3.5 合规提示行）。
 * @why 没有数字：EMS 实际时效未实测（对标分析 §7）；写错的送达承诺比不写更糟（AJ-402 Q2 / FTC 同口径）。
 * @limitation 承运商不点名（"EMS"）：承运商由管理端发货时填，店铺未来可能换；点名就是又一处要同步的写死。
 */
export const SHIPPING_STEPS = [
  { key: 'buy', title: '日本采购', detail: '付款后我们在日本为你采购商品' },
  { key: 'send', title: '日本发出', detail: '打包后从日本寄出，发货后可在订单里看到运单号' },
  { key: 'intl', title: '国际运输', detail: '包裹在国际运输途中，可凭运单号查件' },
  {
    key: 'last',
    title: '清关派送',
    detail:
      '关税已含在商品价内（预估差额由我们承担），清关不需要你另外办理或付费，之后派送到你的收货地址',
  },
];

/**
 * 购买保障（M-03，AJ-405）：价格下的一排标签 + 保障区里逐条说明。
 * @why 每一条都必须是**已定的业务事实**，出处写在这里：
 *      ① 日本采购 · 日本直邮：代购模式（付款后在日本采购，STOCK_REFUND_NOTE）+ 只卖日本原产、从日本发货（D-43）；
 *      ② 价格含美国关税：D-32 / D-69②（DDP，商品价含关税）——说明一字不改沿用 DUTY_NOTE；
 *      ③ 付款后 N 个工作日内发出：N **只取服务端** `ship_within_business_days`（FTC，D-39⑦ / AJ-180）；
 *      ④ 缺货整单全额退款：剩余清单 4-10，与结算页 / 订单详情同一句 STOCK_REFUND_NOTE。
 * @why 不写"正品保障 / 包邮 / X 天送达"：前者需要资质背书，后两者与现行规则不符（运费按重量单列；时效未实测）。
 */
function guaranteesOf(p) {
  const days = p.ship_within_business_days;
  const list = [
    { key: 'origin', tag: '日本采购 · 日本直邮', detail: '商品在日本采购，从日本直接寄往美国' },
    { key: 'duty', tag: '价格含美国关税', detail: DUTY_NOTE },
  ];
  // 时限数字**只取服务端下发**（配置 SHIP_WITHIN_BUSINESS_DAYS）：拿不到合法正整数就不出这一条——
  //    写错的承诺比不写更糟（FTC 未写时限时默认 30 天，不写不违规）
  if (Number.isInteger(days) && days > 0) {
    list.push({
      key: 'ship',
      tag: `付款后 ${days} 个工作日内发出`,
      detail: `付款后 ${days} 个工作日内从日本发出（按日本工作日计，不含日本节假日）；发出不等于送达，运输过程见下方流程`,
    });
  }
  list.push({ key: 'refund', tag: '缺货退款', detail: STOCK_REFUND_NOTE });
  return list;
}

/** 可选字符串（why / maker）：非字符串或空白 → 空串（AJ-296①：缺失时降级，不用通用话术顶上）。 */
function optionalText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 编辑标签：只留非空字符串（契约恒为数组，这里仍防脏值——与首页 vm 同口径再加去空白）。 */
function editorialTags(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
}

/**
 * `GET /products/{id}` 的 Product → 详情视图数据。
 * @param {unknown} product 契约 `Product`（请求失败时页面根本不会调这里）
 * @returns {{title: string, category: string, priceJpy: unknown, subPrice: string, images: string[],
 *            description: string, specs: Array<{label: string, value: string}>, soldOut: boolean, lowStockText: string,
 *            stock: number|null,
 *            why: string, maker: string, tags: string[],
 *            guarantees: Array<{key: string, tag: string, detail: string}>,
 *            shippingSteps: Array<{key: string, title: string, detail: string}>}}
 * @why M-02：`why` / `maker` / `tags` 详情接口本就下发（product-routes.ts 详情分支，契约 0.6.23），
 *      此前详情页漏取——首页卡片说了"为什么值得买"，点进来反而没了。
 * @why `priceJpy` **原样透传、不做任何兜底**（与首页同一口径）：`ws-price` 对非整数
 *      会响亮失败，在这里补 0 会显示 `0 円`——那是价格组件最贵的失败形态。
 */
export function detailView(product) {
  const p = product && typeof product === 'object' ? product : {};
  return {
    title: typeof p.title === 'string' ? p.title : '',
    // A10（AJ-416）：取同类推荐用。只收"像个分类键"的值（拼进请求地址前先挡住脏值），具体有哪些分类由服务端说了算
    category:
      typeof p.category === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(p.category)
        ? p.category
        : '',
    priceJpy: p.price_jpy,
    subPrice: displaySubLine(p.display),
    images: imagesOf(p.images),
    description: typeof p.description === 'string' ? p.description.trim() : '',
    specs: specsOf(p),
    soldOut: Number(p.stock) === 0,
    /**
     * 库存紧张提示（全入口点击测试 2026-10-11）：1–5 件显示"仅剩 N 件"，与首页卡片 ws-pick-card 的口径一致（≤5）。
     * @why 原先详情页没有任何提示，买家点「＋」加不上去才知道只剩 1 件。0 件由「已售罄」标签说，不在这里重复。
     */
    lowStockText:
      Number.isInteger(p.stock) && p.stock >= 1 && p.stock <= 5 ? `仅剩 ${String(p.stock)} 件` : '',
    /** 库存数（审查 2026-10-09：加购上限用）；缺失 / 非法 → null（不知道就不拦，交给报价兜底）。 */
    stock: Number.isInteger(p.stock) && p.stock >= 0 ? p.stock : null,
    why: optionalText(p.why),
    maker: optionalText(p.maker),
    tags: editorialTags(p.tags),
    guarantees: guaranteesOf(p),
    shippingSteps: SHIPPING_STEPS,
  };
}

/** ImageSet[] → 主图 URL 列表；一条图都没有 → [占位图]（不留空数组，轮播会整个消失）。 */
function imagesOf(images) {
  if (!Array.isArray(images)) return [PLACEHOLDER_IMAGE];
  const urls = images.map(imageUrl).filter((u) => u !== '');
  return urls.length > 0 ? urls : [PLACEHOLDER_IMAGE];
}

/** 用户可见的规格行：原产地 + 重量。报关字段不进来（@see 文件头 @why）。 */
function specsOf(p) {
  const specs = [];
  const origin = typeof p.origin_country === 'string' ? p.origin_country : '';
  if (origin !== '') {
    // 展示名缺映射时退回 ISO 码：显示 "DE" 难看，但比"产地一栏空白"诚实
    specs.push({ label: '原产地', value: ORIGIN_LABELS[origin] ?? origin });
  }
  if (Number.isInteger(p.weight_g) && p.weight_g > 0) {
    specs.push({ label: '重量', value: `约 ${p.weight_g} g` });
  }
  return specs;
}

/**
 * 立即购买的单件条目（剩余清单 4-4）：与加购同一份快照形状，数量固定 1（改数量走购物车）。
 * @why 不经购物车：立即购买 = "只买这一件"，塞进购物车再结算会把用户车里别的东西一起带进结算页。
 * @returns {{productId: string, qty: number, title: string, image: string, priceJpy: unknown} | null}
 *          null = 不能买（售罄 / 没 id / 商品没拿到），页面据此不跳转。
 */
export function buyNowItem(view, productId, qty = 1) {
  if (view === null || typeof view !== 'object' || view.soldOut === true) return null;
  if (typeof productId !== 'string' || productId === '') return null;
  return {
    productId,
    // A9（AJ-416）：带上页面选的数量；脏值 / < 1 → 1
    qty: Number.isInteger(qty) && qty >= 1 ? qty : 1,
    title: view.title,
    image: Array.isArray(view.images) ? (view.images[0] ?? '') : '',
    priceJpy: view.priceJpy,
  };
}

/** 同类推荐最多几件（A10）：一屏两行两列，再多就成了第二个首页。 */
const RELATED_MAX = 4;

/** 小程序页面栈上限（官方："页面栈最多十层"）。 */
export const PAGE_STACK_MAX = 10;

/**
 * 点同类推荐用哪种跳转（统一结论 5.3）：栈没满压一层（能按返回回到上一件）；满了替换当前页。
 * @why 原先一律 navigateTo：第 10 层之后点击静默失败、没有任何提示（模拟器实测第 9–11 次点击页面不变）。
 * @tradeoff 满栈时 redirectTo 让"返回"跳过当前这一件——比点了没反应好；不清栈（reLaunch 会丢掉来路）。
 * @param {number} depth 当前页面栈深度（薄壳经 wx-api.pageDepth 取）
 * @returns {'navigateTo' | 'redirectTo'}
 */
export function relatedNavMethod(depth) {
  return depth < PAGE_STACK_MAX ? 'navigateTo' : 'redirectTo';
}

/**
 * 同类推荐（A10，AJ-416）：`GET /products?category=` 的结果 → 小卡片。
 * @why 排除当前这件与售罄的：推荐一件点进去就买不了的，比不推荐更糟。
 * @why 价格非整数的不出：`ws-price` 对非整数响亮失败（空白 + 报错），推荐位不该冒出一个空白价。
 * @returns {Array<{id: string, title: string, image: string, priceJpy: number}>}
 */
export function relatedCards(list, currentId) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        p.id !== '' &&
        p.id !== currentId &&
        Number.isInteger(p.price_jpy) &&
        !(Number.isInteger(p.stock) && p.stock <= 0),
    )
    .slice(0, RELATED_MAX)
    .map((p) => {
      // 契约 ProductCard：列表行是单张 `image`（ImageSet），不是详情的 `images[]`
      const first = imageUrl(p.image);
      return {
        id: p.id,
        title: typeof p.title === 'string' ? p.title : '',
        image: first !== '' ? first : PLACEHOLDER_IMAGE,
        priceJpy: p.price_jpy,
      };
    });
}

/** 分享卡片的品牌兜底标题（商品没拿到时）。 */
const SHARE_FALLBACK_TITLE = 'WaSelect';

/**
 * 分享卡片（剩余清单 4-4，`onShareAppMessage` 的返回值）。
 * @why 路径只带商品 id：打开的人走的是同一个详情页，价格 / 库存实时取，不在分享里固化任何会变的东西。
 * @limitation 分享卡片要上线（有 AppID）后才真正可点开；开发者工具里只能看到卡片形态。
 */
export function shareCard(view, productId) {
  const path = `/pages/detail/index?id=${encodeURIComponent(typeof productId === 'string' ? productId : '')}`;
  if (
    view === null ||
    typeof view !== 'object' ||
    typeof view.title !== 'string' ||
    view.title === ''
  ) {
    return { title: SHARE_FALLBACK_TITLE, path };
  }
  const imageUrl = Array.isArray(view.images) ? view.images[0] : undefined;
  return {
    title: view.title,
    path,
    ...(typeof imageUrl === 'string' && imageUrl !== '' ? { imageUrl } : {}),
  };
}

/**
 * 加购连点守卫窗口（毫秒，P2-37）。
 * @why "加入购物车"不走请求、没有在途态可挡（ws-button 的 loading 也就无从谈起），
 *      手抖双击 = 同一件商品 qty 变成 2，用户到购物车才发现。800ms 覆盖一次双击，又不妨碍有意的"再加一件"。
 * @tradeoff 用时间窗而不是"加过就禁用"：有人确实想连加两件；窗口外的第二下照常生效。
 */
export const ADD_TAP_GUARD_MS = 800;

/**
 * 这一下"加入购物车"要不要接受（P2-37）。
 * @param {unknown} lastAtMs 上一次被接受的时刻（没有 = undefined / 0）
 * @param {number} nowMs 当前时刻（**由薄壳传入**，vm 不读时钟）
 * @returns {boolean}
 * @why 时钟回拨（now < last）按接受处理：否则改一次手机时间就会把按钮锁死很久。
 */
export function acceptAddTap(lastAtMs, nowMs) {
  if (!Number.isFinite(lastAtMs) || lastAtMs <= 0) return true;
  if (!Number.isFinite(nowMs)) return true;
  const gap = nowMs - lastAtMs;
  return gap < 0 || gap >= ADD_TAP_GUARD_MS;
}

/**
 * `cart.add()` 的结果 → 页面 `setData`（P2-31 / P2-37）。
 * @param {unknown} result cart-store `add` 的返回值
 * @returns {{added: boolean, addNote: string}} `addNote` 非空 = 没加进去的原因（页内显示，不弹 toast）
 */
export function addFeedback(result) {
  const r = result !== null && typeof result === 'object' ? result : {};
  if (r.added === true) return { added: true, addNote: '' };
  if (r.reason === 'stock' && Number.isInteger(r.stock)) {
    // A9（AJ-416）：一次加多件时，车里没满也会超库存——说清楚还能加几件，而不是"已经放满了"
    if (Number.isInteger(r.inCart) && r.inCart < r.stock) {
      return {
        added: false,
        addNote: `库存只剩 ${String(r.stock)} 件，购物车里已有 ${String(r.inCart)} 件，最多再加 ${String(r.stock - r.inCart)} 件`,
      };
    }
    return { added: false, addNote: `库存只剩 ${String(r.stock)} 件，购物车里已经放满了` };
  }
  if (r.reason === 'line_max' && Number.isInteger(r.inCart)) {
    const cap = `每件商品一次最多买 ${String(MAX_LINE_QTY)} 件`;
    return {
      added: false,
      addNote:
        r.inCart < MAX_LINE_QTY
          ? `${cap}，购物车里已有 ${String(r.inCart)} 件，最多再加 ${String(MAX_LINE_QTY - r.inCart)} 件`
          : `${cap}，购物车里已经放满了`,
    };
  }
  if (r.reason === 'full') {
    return {
      added: false,
      addNote: `购物车最多放 ${String(MAX_CART_LINES)} 种商品，请先结算或移除一些再加`,
    };
  }
  return { added: false, addNote: '' };
}

/**
 * 底部固定购买栏的视图（M-13，AJ-406）：价格 + 购物车入口（带件数）+ 加入购物车 + 立即购买。
 *
 * @param {{cartCount?: unknown, added?: unknown, soldOut?: unknown}|null|undefined} s
 *   `cartCount` cart-store `count()`；`added` 本次已加购；`soldOut` 详情的售罄态
 * @returns {{cartText: string, cartAria: string, cartLabel: string, cartBadge: string, addText: string, disabled: boolean}}
 * @why 购物车入口**常驻**在栏里，取代原先"加购成功后才冒出来的「去购物车」按钮"：
 *      两个去购物车的入口同屏就是重复（对标分析 M-14 同一条），而常驻入口在加购前也能用。
 * @why 加购反馈写进这个入口（"已加入购物车 · 3"）而不是另起一行：反馈在按钮旁边（§4"位置在按钮附近即可"），
 *      且不改变栏高（栏高是 token，页面底部留白按它算）。
 * @limitation 件数是本地购物车（cart-store），与 tabBar 角标同一来源，不是服务端数据。
 */
export function buyBarView(s) {
  const a = s !== null && typeof s === 'object' ? s : {};
  const badge = cartBadgeText(a.cartCount);
  const base = a.added === true ? '已加入购物车' : '购物车';
  return {
    cartText: badge === '' ? base : `${base} · ${badge}`,
    cartAria: badge === '' ? `${base}，去购物车` : `${base}，共 ${badge} 件，去购物车`,
    // 全入口点击测试 2026-10-11：底部栏左侧改为"购物车格子"（短文字 + 角标），长串 cartText 放不进格子（仍留作 aria / 兼容）。
    // 文字固定「购物车」：它是去购物车的入口，"已加入"读不出能点。
    cartLabel: '购物车',
    cartBadge: badge,
    // 加购成功的反馈写在「加入购物车」按钮上（三天提交复查 2026-10-12：本项目不用 toast，wx-api @limitation 九；
    //   只靠角标的话角标已是 99+ 时什么都不变）。再点照样加。
    addText: a.added === true ? '已加入购物车' : '加入购物车',
    disabled: a.soldOut === true,
  };
}

/**
 * 加购前的库存上限（审查 2026-10-09）：购物车里这件的数量已达库存 → 不加。
 * @why 此前每点一次 +1、没有上限，要到结算报价才 409——用户在购物车里攒了 5 件，结算时才被告知只有 2 件。
 * @limitation 库存是**进页时**的快照；别人同时买走的那部分仍由报价 / 建单兜底，这里只挡"明知不够还加"。
 * @param {{stock: unknown, inCart: unknown, qty?: unknown}} a `stock` 详情的库存（null = 不知道）；`inCart` 购物车里这件已有几件；
 *        `qty` 这次要加几件（A9，缺省 1）
 * @returns {{ok: true} | {ok: false, reason: 'stock', stock: number} | {ok: false, reason: 'line_max', inCart: number}}
 */
export function addLimit(a) {
  const stock = a?.stock;
  const inCart = Number.isInteger(a?.inCart) ? a.inCart : 0;
  const qty = Number.isInteger(a?.qty) && a.qty >= 1 ? a.qty : 1;
  if (Number.isInteger(stock) && inCart + qty > stock) return { ok: false, reason: 'stock', stock };
  // 单行上限（规律排查 2026-10-12）：cart.add 会把超过 99 的部分截掉、却仍回 added——买家看到"已加入"，其实没加上
  if (inCart + qty > MAX_LINE_QTY) return { ok: false, reason: 'line_max', inCart };
  return { ok: true };
}

/**
 * 详情页数量步进（A9，AJ-416）：1 起步，不超过库存，且不超过单行上限 99（AJ-448）。
 * @why 原先「立即购买」恒为 1 件——想买两件的人只能先结一件、再回来买一件，或绕道购物车改数量。
 * @param {unknown} current 当前数量
 * @param {number} delta +1 / -1
 * @param {unknown} stock 库存（null = 不知道）
 */
export function stepQty(current, delta, stock) {
  // 当前值是脏的 → 回到 1（不在一个不知道是多少的数上再加减）
  if (!Number.isInteger(current) || current < 1) return 1;
  const base = current;
  // 封顶 = min(库存, 单行上限)：库存 500 也只能加到 99（AJ-448，与服务端契约 qty.maximum 同值）
  const cap = Math.min(Number.isInteger(stock) && stock >= 1 ? stock : MAX_LINE_QTY, MAX_LINE_QTY);
  return Math.min(Math.max(base + delta, 1), cap);
}

/**
 * 数量到上限时的说明（F8，第二轮审计 2026-10-11）：点「＋」点不动时说为什么。
 * @why 原先到上限后再点没有任何反馈，像按钮坏了。库存数此处照说（加购提示 `addNote` 已经在说"库存只剩 N 件"，口径一致）。
 * @param {unknown} qty 当前数量
 * @param {unknown} stock 库存（null = 不知道 → 只受单件上限 99 约束）
 * @returns {string} 空串 = 没到上限（不说）
 */
export function qtyCapText(qty, stock) {
  if (!Number.isInteger(qty)) return '';
  const byStock = Number.isInteger(stock) && stock >= 1 && stock < MAX_LINE_QTY;
  const cap = byStock ? stock : MAX_LINE_QTY;
  if (qty < cap) return '';
  return byStock
    ? `库存只剩 ${String(stock)} 件，最多买 ${String(stock)} 件`
    : `每件商品一次最多买 ${String(MAX_LINE_QTY)} 件`;
}

/**
 * 回到详情页时"已加入购物车"还算不算数（审查 2026-10-09）：去购物车把这件删了再回来，
 * 按钮仍写"已加入购物车"、角标却是 0——两处说法相反。购物车里已没有这件 → 复位。
 */
export function stillAdded(added, inCart) {
  return added === true && Number.isInteger(inCart) && inCart > 0;
}

/**
 * 取详情失败时状态块的样子（全入口点击测试 2026-10-11）。
 * @why 下架商品原先标题"没能取到这件商品"、还挂"联系客服时请提供：40401 · mp-…"——下架是正常状态不是故障，
 *      买家读成"系统坏了"、去找客服。主流做法：空态"该商品已下架"，按钮去逛别的，不出错误码。
 * @limitation 只认 40401；其余失败返回错误态的标题，原因与求助编号仍由 errorFields 给（这里不覆盖）。
 * @param {unknown} err
 * @returns {{failKind: 'empty'|'fail', failTitle: string, error?: string, errorRef?: string}}
 */
export function loadFailView(err) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  if (code === 40401) {
    return {
      failKind: 'empty',
      failTitle: '这件商品已下架',
      error: '商品已停售或不存在，去首页看看别的吧',
      errorRef: '',
    };
  }
  return { failKind: 'fail', failTitle: '没能取到这件商品' };
}

/** 取详情失败能不能"重试"（审查 2026-10-09）：已下架 / 不存在（40401）重试一万次也一样，不给按钮。 */
export function retryableLoadError(err) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  return code !== 40401;
}
