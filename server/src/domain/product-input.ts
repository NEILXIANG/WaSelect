/**
 * 职责：管理端商品输入（`ProductInput`）的**纯校验与归一化**（I2）。
 *
 * 边界：只判"这个输入能不能进库"，不管"谁有权改"（那是 `requireAdmin`）、
 *      也不做落库（那是 `adapters/catalog-admin.ts`；⚠️ 曾经写 `catalog.ts`——
 *      那是**买家侧读**的仓储，写入方是 `catalog-admin.ts`）。domain 层不依赖 express / db。
 *
 * @why 合规拦截放在**校验函数**里而不是留在路由的 if 串里：七个"上架即拒"标签
 *      （D-42 航空禁寄 flammable/aerosol、D-45 不上电器 electrical、D-51 医薬部外品
 *      quasi_drug / SPF sunscreen / CPSIA children_product / 酒类 alcohol）一旦漏检，
 *      后果是**货被海关扣留或卖到 OTC 药品边界**，而漏检的表现是"商品静静上架了"——
 *      没有任何一方报错。做成函数才能被单测逐条钉住。
 *
 * @why **错误一次收集全部**（`errors` 是数组，不是遇到第一个就 return）：管理端是表单，
 *      只报第一条会让运营"改一次、提交一次、再看到下一个错"，来回 N 次。
 *
 * @tradeoff 归一化后的对象**丢弃未识别字段**（白名单逐字段读），而不是把 raw 透传给 SQL。
 *      代价：契约新增字段时要同步改这里（漏了会静默丢弃）；
 *      收益：不存在"前端多传一个字段就写进库"的注入面。
 *
 * @limitation 一：禁词按**词边界**比（`\b…\b`，大小写不敏感）——"drugstore" 不算命中 "drug"，
 *              但反过来也意味着"drug.store"这种拆写能绕过。**这是刻意不补的洞**：
 *              报关品名由管理员手填且商品量极小，海关侧的最终责任在申报人；
 *              把规则做成"猜运营商怎么写"只会产出误伤。
 * @limitation 二：`hs_code` 只判**填没填**（所有商品必填，剩余清单 1-4 / AJ-368；
 *              此前仅 food / cosmetic 必填，D-39/D-42），不校验它是真实存在的 HS 编码——
 *              那是通関業者的职责。
 *
 * @see contracts/api-contract.yaml（ProductInput）；packages/shared/src/enums.ts
 *      （COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG；分类自 AJ-491 起改为查 product_categories 表）
 */
import {
  BLOCKED_COMPLIANCE_TAG,
  COMPLIANCE_TAG,
  PRODUCT_MAX_CHARS,
  PRODUCT_MAX_STOCK,
  PRODUCT_MAX_WEIGHT_G,
  isOneOf,
} from '@waselect/shared';
import { isImageId } from './upload-image.js';

export interface ProductImageSet {
  thumb: string;
  card: string;
  detail: string;
}

/**
 * 按 **image_id** 存的图片条目（0.6.28 / AJ-361）。
 *
 * @why 与 `ProductImageSet`（三档完整 URL）**并存**是刻意的：商品图此前存的是三档 URL，
 *      而 URL 里含域名/CDN 前缀（= 存储位置）——换图床时历史数据全部失效。
 *      `image_id` 只是三档的**共同主键**（`img/{id}/{tier}.webp`），不含位置信息，
 *      与 Banner 存 `image_key` 是同一条理由（AJ-143）。
 * @why 商品**不能**照抄 Banner 存单个 `image_key`：Banner 只展示一档（detail），
 *      商品要 thumb / card / detail 三档；由 key 反解出另外两档是"靠字符串巧合工作"
 *      （AJ-143 已否）。所以存 id，三档键由 `imageObjectKey` 生成——键形只有一处定义。
 * @limitation 它**不是**"替代" `ProductImageSet`：管理端当前仍在存三档 URL，
 *              两种形态在库里会共存一段时间，读路径（`toImageSet`）两种都要认。
 */
export interface ProductImageRef {
  image_id: string;
}

/** `products.images` 的一个条目：三档 URL（旧）或 image_id（新）。 */
export type ProductImageEntry = ProductImageSet | ProductImageRef;

/** 归一化后的商品输入（可选字段已补默认，可直接进仓储）。 */
export interface ProductInput {
  title: string;
  category: string;
  description?: string | undefined;
  images: readonly ProductImageEntry[];
  price_jpy: number;
  cost_jpy?: number | undefined;
  weight_g: number;
  /**
   * 库存；**省略 = 不改**（更新路径保持原值；新建路径由调用方取 0）。
   * @why 库存是**并发写**的列：建单扣减、取消/关单回补都在改它。管理端"读 → 改标题 → 整体 PUT"
   *      若总带着读到的旧库存，会把期间被扣掉/回补的数量覆盖回去（丢失更新 → 超卖或少卖）。
   *      所以只有管理员**确实改了库存**时才发这个字段（admin-web toProductInput 只在变动时带），
   *      省略时服务端不碰它（AJ-175）。
   */
  stock?: number | undefined;
  compliance_tags: readonly string[];
  hs_code?: string | undefined;
  customs_desc_en: string;
  origin_country: string;
  title_ja?: string | undefined;
  jan_code?: string | undefined;
  purchase_source?: string | undefined;
  /**
   * 编辑口径的"为什么值得买"（020 迁移新增，`products.why`）。
   * @why **可选**：必填会逼运营"随便填一句"交差，首页立刻出现一批假文案——
   *      这比留白更伤（用户旅程地图：`why` 退化成口号 → 品牌差异化消失）。
   * @see ../../../migrations/020_product_editorial_fields.sql
   */
  why?: string | undefined;
  /** 产地 / 工房 / 匠人名（020 迁移新增，`products.maker`）；可选，留白时前端不渲染。 */
  maker?: string | undefined;
  /** 编辑展示标签（020 迁移新增，`products.tags`）；可选，默认 `[]`。 */
  tags?: readonly string[] | undefined;
}

/** 字段级错误：`field` 用**契约键名**，前端直接按它定位表单项。 */
export interface ProductFieldError {
  field: string;
  reason: string;
}

export type ProductInputResult =
  { ok: true; value: ProductInput } | { ok: false; errors: readonly ProductFieldError[] };

/** 报关品名禁词（D-51）：命中即拒，大小写不敏感、按词边界（@limitation 一）。 */
const FORBIDDEN_DESC = /\b(medicated|whitening|spf|sunscreen|drug)\b/i;

/** 正整数（≥min），非整数/非数字/越界一律 undefined（由调用方转成错误）。 */
function intAtLeast(v: unknown, min: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : undefined;
}

/**
 * 可选字符串：**填了却不是字符串 → 报 `<field>_invalid`**（CAT2-06 / AJ-352）。
 *
 * @why 旧实现是 `typeof v === 'string' && v !== '' ? v : undefined`——类型不对时返回
 *      `undefined`，于是"**传错类型**"与"**没传**"在下游**不可区分**。而本函数的产出
 *      直接进 `PUT /admin/products/{id}` 的整行覆盖：路由把 `undefined` 写成 `null` ⇒
 *      非前端调用方（批量导入脚本、将来的接口使用者）传 `hs_code: 330499` 时——
 *        · 不带 food / cosmetic 标签 ⇒ **200**，库里原有的 HS 码被**静默清空**，没有任何报错；
 *        · 带 food 标签 ⇒ 报 `hs_code_required`，而真实原因是"类型填错了"——
 *          提示指向"去补一个你其实已经补了的值"，运营会在那里反复折腾。
 *      两类都属于"错了但不响"，与库存那条（AJ-175）是同一类静默丢失，只是方向相反。
 * @why 空串与 `null` 仍按"没填"处理：空串不该落库替代 null（二者都是"这一项没有"）。
 *      ⚠️ 因此"清空这个字段"的正确写法是显式 `null`，不是 `''`——`''` 与省略同义。
 * @why 报错而不是"强转字符串"：`String(330499)` 会静默写出 `'330499'`，看起来"修好了"，
 *      但它把调用方的错当成事实接受下来——他传的是数字，说明他那边的字段口径就不对，
 *      今天能转的那几个值纯属运气（转成 `'[object Object]'` 也只是时间问题）。
 */
/**
 * "没填"的判定——`undefined` / `null` / 空串三种同义。
 *
 * @why **一处定义、两处使用**（`strField` 判"要不要报错"、必填项判"要不要报 required"）：
 *      同一个"什么算没填"写两遍，改一边漏一边的结果就是同一条输入出现两条矛盾的提示
 *      ——"你没填"（required）与"你填的类型不对"（invalid）。
 *      ⚠️ 判必填**必须**用它而不是"归一化后的值是 undefined"：后者在类型不对时
 *      同样是 undefined，于是必填判定会把"类型错"误读成"没填"。
 */
/**
 * "这一项算没填吗"。**纯空白也算没填**（不只空串）。
 *
 * @why 这三个形态在**报关单上没有任何区别**：`customs_desc_en` 是 `'   '` 时
 *      导出的报关 CSV 这一栏就是空的，与没填的后果完全相同（承运商/海关退回）。
 *      `hs_code` 早就按这个口径判了（见下方 hs 段），而 `customs_desc_en` 与 `title`
 *      没有——同一份文件里两个必填字段两种口径，是"改了一半"的典型形态。
 * @why 放在 `isBlank` 里而不是逐个调用点补 `trim()`：可选字段同样受益——
 *      `description: '   '` 现在按"没填"处理（PUT 下 = **清空**写 NULL，与 `''` / `null` 同；复核 AJ-374 订正原"= 不改"），而不是往库里写三个空格，
 *      再在详情页渲染出一块看起来是空的区域。
 * @limitation 它**不负责归一化**：`'  cosmetic set  '` 仍然原样保存（前后空格保留）。
 *              收窄范围是因为"要不要 trim 掉两端空格"是展示口径而不是校验口径，
 *              一并改会牵动存量数据与读侧渲染；这里只堵"整项都是空白"这个明确的事故。
 * @limitation 全角空格 U+3000 同样算空白（JS 的 `trim()` 覆盖它）——
 *              中文输入法下敲空格极易产出它，只按 ASCII 空格判等于没堵。
 */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function strField(
  b: Record<string, unknown>,
  field: string,
  fail: (field: string, reason: string) => void,
): string | undefined {
  const v = b[field];
  if (isBlank(v)) return undefined;
  if (typeof v !== 'string') {
    fail(field, `${field}_invalid`);
    return undefined;
  }
  return v;
}

/**
 * `images` 条目：三档 URL（旧形态）或 `{image_id}`（0.6.28 / AJ-361 新形态）。
 *
 * @why 新形态**必须是对象**而不是裸字符串 id：裸字符串在库里已经有含义（一档 URL），
 *      让 id 也用裸字符串 ⇒ 读路径只能靠"像不像 id"去猜，规则一变就静默判错。
 *      做成对象后"这是 id"写在形状里，两种形态**不需要任何启发式**就能分开。
 * @why `image_id` **入库前就用 `isImageId` 判合法性**（而不是等读的时候渲染不出来）：
 *      非法 id 存进去之后永远拼不出键，表现为"这张图不见了"，而写的人看到的是 200 ——
 *      与脏价格 / 脏汇率同属"静默的错"，写入侧能拦就别留给读侧降级（AJ-211 同条立场）。
 *      判定用 `isImageId`（`domain/upload-image.ts` 的单一真源），本文件不另写正则。
 * @limitation `image_id` 与 `thumb/card/detail` **混填**判 invalid，**不是**"id 优先"：
 *              两者若指向**不同**的图，取 id 的表现是"写入返回 200、显示的是另一张图"——
 *              这是本项目最难查的一类错（没有任何一方报错）。让调用方先把话说清楚，
 *              比替它猜便宜。与 AJ-353（"填了却不是布尔"报错而非静默当成启用）同一条立场。
 *              ⚠️ `image_key` 不算混填：它不是档位，只是上传响应带出的附加键，
 *              存量条目里本来就有（读侧同理忽略），拦它只会误拒合法的历史数据。
 */
function readImages(v: unknown): readonly ProductImageEntry[] | 'invalid' {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return 'invalid';
  const out: ProductImageEntry[] = [];
  for (const it of v) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) return 'invalid';
    const o = it as Record<string, unknown>;
    const id = o['image_id'];
    const hasTierKeys =
      o['thumb'] !== undefined || o['card'] !== undefined || o['detail'] !== undefined;
    if (id !== undefined) {
      if (hasTierKeys) return 'invalid'; // 混填（@limitation）
      if (typeof id !== 'string' || !isImageId(id)) return 'invalid';
      out.push({ image_id: id });
      continue;
    }
    if (
      typeof o['thumb'] === 'string' &&
      typeof o['card'] === 'string' &&
      typeof o['detail'] === 'string'
    ) {
      out.push({ thumb: o['thumb'], card: o['card'], detail: o['detail'] });
      continue;
    }
    return 'invalid';
  }
  return out;
}

/**
 * 校验并归一化商品输入。
 *
 * @param maxPriceJpy 单价上限（调用方传 `config.MAX_ORDER_JPY`）。
 *   @why 单价必须**有上界**（B25 / AJ-211）：`toMinor(price_jpy, rateInt)` 的乘积
 *        超过 2^53 会抛 RangeError，而浏览页对每个商品都做一次换算 ⇒
 *        **一个商品就能让整页 500**（文件头 AJ-108 承诺"浏览路径降级、不白屏"，被这一条打破）。
 *        按含缓冲的人民币汇率，门槛约 1.8×10⁹ 円——离谱单价（录入多打几个零）很够得着。
 *   @why 上界取**单笔订单上限**而不是另起一个常量：单价高于它就永远卖不出去
 *        （买 1 件已到顶），且它会与 MAX_ORDER_JPY 一起调，不会像两个常量那样各自漂移。
 *   @limitation 它是调用方传入的（本函数是纯函数、不读配置），
 *        **调用方必须传 `config.MAX_ORDER_JPY`**——写死一个数字就退回"两处真值"。
 *
 * @returns 通过时 `value` 是白名单字段的归一化对象；不通过时 `errors` 含**全部**问题。
 */
/**
 * 网页标签（`<b>` / `</b>` / `<script>` / `<img …>`）：买家看得到的文字字段里一律不收（AJ-490）。
 * @why 三端模拟测试 2026-10-11（用户截图指出）：后台列表里商品名是「<b>加粗</b> 测试 <script>alert(1)</script> 抹茶」——
 *      渲染端都按文字转义了（不会执行），但这串符号买家会原样看到；运营从网页复制商品名时最容易带进来。
 *      安全靠的仍是渲染端转义，这里拦的是"给买家看的字不该有代码"。
 * @limitation 只认"< 后紧跟字母或 /"的写法：「<5cm」「a < b」「<<限定>>」照收；`&lt;b&gt;` 这种实体写法不拦（它显示出来就是 <b>，但极少有人这样贴）。
 */
/** 分类键的形状（与迁移 039 product_categories_key_check 同口径）。 */
export const CATEGORY_KEY = /^[a-z][a-z0-9_]{1,31}$/;

export const HTML_TAG = /<\/?[A-Za-z][^<>]*>/;

export function validateProductInput(raw: unknown, maxPriceJpy: number): ProductInputResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: [{ field: 'body', reason: 'not_object' }] };
  }
  const b = raw as Record<string, unknown>;
  const errors: ProductFieldError[] = [];
  const fail = (field: string, reason: string): void => {
    errors.push({ field, reason });
  };

  // ── 必填六项（契约 required）────────────────────────────────────────────
  const title = typeof b.title === 'string' ? b.title : undefined;
  // 用 isBlank 而不是 `=== ''`：纯空格的标题存进去之后，商品卡片上就是一块空白，
  // 而管理端列表里它看起来"填过了"（不像空串那样明显），运营不会回去补。
  // ⚠️ `title === undefined` 那一半不是冗余：`isBlank` 返回 `boolean` 而不是类型收窄，
  //    少了它 TS 会认为下面 `title.length` 仍可能是 undefined（实测 TS18048）。
  if (title === undefined || isBlank(title)) fail('title', 'title_required');
  else if (title.length > PRODUCT_MAX_CHARS.title) fail('title', 'title_too_long');
  else if (HTML_TAG.test(title)) fail('title', 'html_not_allowed');

  const category = b.category;
  if (category === undefined) fail('category', 'category_required');
  // AJ-491：分类改为后台可配置（product_categories）——这里只判键的形状（与表的 CHECK 同口径），
  //   存在与否由路由查库（categoryExists → category_unknown）；纯函数不碰库
  else if (typeof category !== 'string' || !CATEGORY_KEY.test(category))
    fail('category', 'category_invalid');

  // 缺（required）与"填了但不合法"分开报：这两类错误的修法不同（补填 vs 改正），
  // 合成一个 reason 会让运营看不出"我到底是没填还是填错了"
  const price = b.price_jpy === undefined ? undefined : intAtLeast(b.price_jpy, 1);
  if (b.price_jpy === undefined) fail('price_jpy', 'price_required');
  else if (price === undefined) fail('price_jpy', 'price_invalid');
  // 上界：见本函数 @param maxPriceJpy（B25 / AJ-211）。超限不是"贵"，是"会让整页 500"
  else if (price !== undefined && price > maxPriceJpy) fail('price_jpy', 'price_too_large');

  const weight = b.weight_g === undefined ? undefined : intAtLeast(b.weight_g, 1);
  if (b.weight_g === undefined) fail('weight_g', 'weight_required');
  else if (weight === undefined) fail('weight_g', 'weight_invalid');
  // 上界（AJ-298）：与运费档的 30kg 同源。缺它时"超重商品"能通过上架校验，
  // 而后果落在买家身上——她没买几件却收到 40912「包裹超重」，且提示指向不了真正的原因。
  else if (weight > PRODUCT_MAX_WEIGHT_G) fail('weight_g', 'weight_too_large');

  const desc = strField(b, 'customs_desc_en', fail);
  // ⚠️ 判"没填"用 `isBlank(b['customs_desc_en'])` 而不是 `desc === undefined`：
  //    传了非字符串时 `desc` 也是 undefined，但那时已经报过 `customs_desc_en_invalid`，
  //    再补一条 `customs_desc_required` 就是两个互相矛盾的提示（"你没填" vs "类型不对"）。
  if (isBlank(b['customs_desc_en'])) fail('customs_desc_en', 'customs_desc_required');
  // `desc !== undefined` 这一半是给"填了但类型不对"兜的：那时 desc 是 undefined，
  // 拿去 test() 会按字符串 "undefined" 比——不炸，但会多出一条毫无道理的 forbidden。
  else if (desc !== undefined && FORBIDDEN_DESC.test(desc)) {
    fail('customs_desc_en', 'customs_desc_forbidden');
  }

  const origin = b.origin_country;
  if (origin === undefined) fail('origin_country', 'origin_required');
  else if (origin !== 'JP') fail('origin_country', 'origin_invalid');

  // ── 可选数值（填了就必须合法；不填用默认）───────────────────────────────
  // 库存省略 = 不改（见 ProductInput.stock 的 @why；⚠️ 曾经写 ProductInputValue——没有这个类型）
  // 上界（两端输入测试 2026-10-12）：缺它时库存 99999999999 越过 products.stock INT、成本价 1e20 越过 BIGINT，
  // 都在库里才被拒（22003，按设计归 500）——运营只看到"服务器内部错误"。
  const stock = b.stock === undefined ? undefined : intAtLeast(b.stock, 0);
  if (b.stock !== undefined && stock === undefined) fail('stock', 'stock_invalid');
  else if (stock !== undefined && stock > PRODUCT_MAX_STOCK) fail('stock', 'stock_too_large');
  const cost = b.cost_jpy === undefined ? undefined : intAtLeast(b.cost_jpy, 0);
  if (b.cost_jpy !== undefined && cost === undefined) fail('cost_jpy', 'cost_invalid');
  // 成本价借用售价的上界：一件货的进价比单笔订单上限还高，这件商品按任何售价都卖不出去——只能是多打了 0。
  // @tradeoff 业务上界而不是 BIGINT 上界：后者（9.2e18）早已越过 2^53，JS 里连"等于上界"都表示不准。
  else if (cost !== undefined && cost > maxPriceJpy) fail('cost_jpy', 'cost_too_large');

  // ── 合规标签：未登记 → 拒（拼错 = 拦截静默失效）；七个拦截标签 → 上架即拒 ──
  let tags: readonly string[] = [];
  if (b.compliance_tags !== undefined) {
    if (!Array.isArray(b.compliance_tags)) fail('compliance_tags', 'tags_invalid');
    else {
      const list = (b.compliance_tags as unknown[]).map((t) => (t === null ? '' : String(t)));
      if (list.some((t) => !isOneOf(COMPLIANCE_TAG, t))) fail('compliance_tags', 'tag_invalid');
      else if (list.some((t) => (BLOCKED_COMPLIANCE_TAG as readonly string[]).includes(t))) {
        fail('compliance_tags', 'tag_blocked');
      } else tags = list;
    }
  }

  // ── HS 码：所有商品必填（剩余清单 1-4 / AJ-368）──────────────────────────
  // @why PRD §7 与 GUI 都写"上架必填"；契约原先的"缺省由 Zonos 识别"从未落地（Zonos 未接入），
  //      缺省的真实后果是报关单 / 报关 CSV 上 HS 码一栏空白。原"只有 food / cosmetic 必填"一并收紧。
  // @tradeoff 存量没填 HS 码的商品，下一次编辑保存时会被要求补齐（不做静默回填——编不出真实 HS 码）。
  const hs = strField(b, 'hs_code', fail);
  // ⚠️ 同上：判"没填"用 `isBlank(b['hs_code'])`，不用 `hs === undefined`——
  //    传了数字 HS 码（Excel 导入最常见的形态）时后者为真，于是食品/化妆品会同时收到
  //    `hs_code_required`（"你没填"）与 `hs_code_invalid`（"你填的类型不对"），
  //    而运营按前者去补一个她其实已经补了的值，永远补不对。
  // 纯空白也算没填：'   ' 进了报关单与空白无异（类型错仍只报 hs_code_invalid，见上）。
  // 这条口径已**上移到 `isBlank`**（本轮统一）：`title` / `customs_desc_en` 原先漏了同一条，
  // 两处各写一遍就是两份真源，改一处漏一处时"HS 码堵住了、报关品名没堵住"这种错不会报错。
  const hsRaw = b['hs_code'];
  if (isBlank(hsRaw)) fail('hs_code', 'hs_code_required');

  // ── 其余可选字段 ────────────────────────────────────────────────────────
  // ⚠️ 四个可选文本字段此前**只判"填没填"不判长度**（AJ-298）：超长会撞 PG 的 22001，
  //    被 `http.ts` 的 22 类兜底折成泛化的 40001「参数缺失或格式错误」——
  //    运营看到的是"参数有问题"，而不是"这一项太长"，提示指向错误的字段。
  if (desc !== undefined && desc.length > PRODUCT_MAX_CHARS.customs_desc_en) {
    fail('customs_desc_en', 'customs_desc_too_long');
  }
  const titleJa = strField(b, 'title_ja', fail);
  if (titleJa !== undefined && titleJa.length > PRODUCT_MAX_CHARS.title_ja) {
    fail('title_ja', 'title_ja_too_long');
  } else if (titleJa !== undefined && HTML_TAG.test(titleJa)) fail('title_ja', 'html_not_allowed');
  const source = strField(b, 'purchase_source', fail);
  if (source !== undefined && source.length > PRODUCT_MAX_CHARS.purchase_source) {
    fail('purchase_source', 'purchase_source_too_long');
  }
  const description = strField(b, 'description', fail);
  if (description !== undefined && HTML_TAG.test(description))
    fail('description', 'html_not_allowed');

  const images = readImages(b.images);
  if (images === 'invalid') fail('images', 'image_invalid');
  const jan = strField(b, 'jan_code', fail);
  // ⚠️ reason 从 `jan_code_invalid` 改成 `jan_code_too_long`（AJ-352）：长度超限与类型不对
  //    是两种修法（改短 vs 改成字符串），而 AJ-352 起"类型不对"占用了 `_invalid` 这个后缀
  //    （与 `price_invalid` / `stock_invalid` 同口径）。沿用旧名会让两者**同一个 reason**，
  //    运营与日志都分不清。其余五个字段的长度 reason 本来就是 `_too_long`，这次是补齐。
  if (jan !== undefined && jan.length > PRODUCT_MAX_CHARS.jan_code) {
    fail('jan_code', 'jan_code_too_long');
  }
  if (hs !== undefined && hs.length > PRODUCT_MAX_CHARS.hs_code) {
    fail('hs_code', 'hs_code_too_long');
  }

  // ── 编辑口径三字段（020 / AJ-296①）——S4 迁 pick-card 的前置 ──────────────
  //
  // @why 三者**全部可选**：它们的性质是"编辑撰写的内容"，不是"商品能不能卖的事实"。
  //      缺了 `customs_desc_en` 商品发不出去，缺了 `why` 只是卡片降级——
  //      把两者放在同一条必填线上，运营会为了上架而编一句，那正是设计侧点名的退化。
  // @why 长度**逐个判**（与 AJ-298 那四个可选文本同口径）：超长会撞 PG 的 22001，
  //      被兜底折成泛化的 40001「参数缺失或格式错误」——提示指向错误的字段。
  const why = strField(b, 'why', fail);
  if (why !== undefined && why.length > PRODUCT_MAX_CHARS.why) fail('why', 'why_too_long');
  else if (why !== undefined && HTML_TAG.test(why)) fail('why', 'html_not_allowed');
  const maker = strField(b, 'maker', fail);
  if (maker !== undefined && maker.length > PRODUCT_MAX_CHARS.maker) {
    fail('maker', 'maker_too_long');
  } else if (maker !== undefined && HTML_TAG.test(maker)) fail('maker', 'html_not_allowed');

  // tags：自由文案字符串数组（与 compliance_tags 的封闭枚举**分工不同**，见迁移注释）
  // @why 逐项判"必须是非空字符串"而不是整体判 Array.isArray：
  //      `tags: ['产地直送', null]` 会渲染出一个空的标签块（一个空的小色块），
  //      而它在 DB 里存得下、在 JSON 里合法——唯一能拦的地方就是这里。
  let editorialTags: readonly string[] | undefined;
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) fail('tags', 'tags_invalid');
    else {
      const list = (b.tags as unknown[]).map((t) => (typeof t === 'string' ? t.trim() : ''));
      if (list.some((t) => t === '')) fail('tags', 'tags_invalid');
      else if (list.some((t) => HTML_TAG.test(t))) fail('tags', 'html_not_allowed');
      else editorialTags = list;
    }
  }

  if (errors.length > 0 || title === undefined || price === undefined || weight === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      title,
      category: String(category),
      ...(description !== undefined ? { description } : {}),
      images: images === 'invalid' ? [] : images,
      price_jpy: price,
      ...(cost !== undefined ? { cost_jpy: cost } : {}),
      weight_g: weight,
      ...(stock !== undefined ? { stock } : {}),
      compliance_tags: tags,
      ...(hs !== undefined ? { hs_code: hs } : {}),
      customs_desc_en: desc ?? '',
      origin_country: 'JP',
      ...(titleJa !== undefined ? { title_ja: titleJa } : {}),
      ...(jan !== undefined ? { jan_code: jan } : {}),
      ...(source !== undefined ? { purchase_source: source } : {}),
      ...(why !== undefined ? { why } : {}),
      ...(maker !== undefined ? { maker } : {}),
      // ⚠️ 空数组**也要带上**（`tags: []`）：PUT 的语义是"覆盖"，
      //    省略 = 不改（与 `stock` 同口径），带了空数组才是"清空标签"。
      //    把 [] 当成"没填"会让运营删掉最后一个标签时删不掉——
      //    保存后标签又回来了，且没有任何报错。
      ...(editorialTags !== undefined ? { tags: editorialTags } : {}),
    },
  };
}
