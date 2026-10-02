/**
 * 职责：管理端商品输入（`ProductInput`）的**纯校验与归一化**（I2）。
 *
 * 边界：只判"这个输入能不能进库"，不管"谁有权改"（那是 `requireAdmin`）、
 *      也不做落库（那是 `adapters/catalog.ts`）。domain 层不依赖 express / db。
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
 * @limitation 二：`hs_code` 只判**填没填**（food / cosmetic 必填，D-39/D-42），
 *              不校验它是真实存在的 HS 编码——那是 Zonos / 通関業者的职责。
 *
 * @see contracts/api-contract.yaml（ProductInput）；packages/shared/src/enums.ts
 *      （PRODUCT_CATEGORY / COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG）
 */
import {
  BLOCKED_COMPLIANCE_TAG,
  COMPLIANCE_TAG,
  PRODUCT_CATEGORY,
  PRODUCT_MAX_CHARS,
  PRODUCT_MAX_WEIGHT_G,
  isOneOf,
} from '@waselect/shared';

export interface ProductImageSet {
  thumb: string;
  card: string;
  detail: string;
}

/** 归一化后的商品输入（可选字段已补默认，可直接进仓储）。 */
export interface ProductInput {
  title: string;
  category: string;
  description?: string | undefined;
  images: readonly ProductImageSet[];
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

/** 这两个标签必须带 HS 码（D-39/D-42 食品 / 化妆品）。 */
const HS_REQUIRED_TAGS: readonly string[] = ['food', 'cosmetic'];

/** 正整数（≥min），非整数/非数字/越界一律 undefined（由调用方转成错误）。 */
function intAtLeast(v: unknown, min: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : undefined;
}

/** 可选字符串：undefined 与空串都当"没填"（空串不该落库替代 null）。 */
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function readImages(v: unknown): readonly ProductImageSet[] | 'invalid' {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return 'invalid';
  const out: ProductImageSet[] = [];
  for (const it of v) {
    const o = it as { thumb?: unknown; card?: unknown; detail?: unknown } | null;
    if (
      o === null ||
      typeof o !== 'object' ||
      typeof o.thumb !== 'string' ||
      typeof o.card !== 'string' ||
      typeof o.detail !== 'string'
    ) {
      return 'invalid';
    }
    out.push({ thumb: o.thumb, card: o.card, detail: o.detail });
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
  if (title === undefined || title === '') fail('title', 'title_required');
  else if (title.length > PRODUCT_MAX_CHARS.title) fail('title', 'title_too_long');

  const category = b.category;
  if (category === undefined) fail('category', 'category_required');
  else if (!isOneOf(PRODUCT_CATEGORY, category)) fail('category', 'category_invalid');

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

  const desc = strOpt(b.customs_desc_en);
  if (desc === undefined) fail('customs_desc_en', 'customs_desc_required');
  else if (FORBIDDEN_DESC.test(desc)) fail('customs_desc_en', 'customs_desc_forbidden');

  const origin = b.origin_country;
  if (origin === undefined) fail('origin_country', 'origin_required');
  else if (origin !== 'JP') fail('origin_country', 'origin_invalid');

  // ── 可选数值（填了就必须合法；不填用默认）───────────────────────────────
  // 库存省略 = 不改（见 ProductInputValue.stock 的 @why）；填了就必须合法
  const stock = b.stock === undefined ? undefined : intAtLeast(b.stock, 0);
  if (b.stock !== undefined && stock === undefined) fail('stock', 'stock_invalid');
  const cost = b.cost_jpy === undefined ? undefined : intAtLeast(b.cost_jpy, 0);
  if (b.cost_jpy !== undefined && cost === undefined) fail('cost_jpy', 'cost_invalid');

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

  // ── HS 码：食品 / 化妆品必填 ────────────────────────────────────────────
  const hs = strOpt(b.hs_code);
  if (hs === undefined && tags.some((t) => HS_REQUIRED_TAGS.includes(t))) {
    fail('hs_code', 'hs_code_required');
  }

  // ── 其余可选字段 ────────────────────────────────────────────────────────
  // ⚠️ 四个可选文本字段此前**只判"填没填"不判长度**（AJ-298）：超长会撞 PG 的 22001，
  //    被 `http.ts` 的 22 类兜底折成泛化的 40001「参数缺失或格式错误」——
  //    运营看到的是"参数有问题"，而不是"这一项太长"，提示指向错误的字段。
  const customsDesc = strOpt(b.customs_desc_en);
  if (customsDesc !== undefined && customsDesc.length > PRODUCT_MAX_CHARS.customs_desc_en) {
    fail('customs_desc_en', 'customs_desc_too_long');
  }
  const titleJa = strOpt(b.title_ja);
  if (titleJa !== undefined && titleJa.length > PRODUCT_MAX_CHARS.title_ja) {
    fail('title_ja', 'title_ja_too_long');
  }
  const source = strOpt(b.purchase_source);
  if (source !== undefined && source.length > PRODUCT_MAX_CHARS.purchase_source) {
    fail('purchase_source', 'purchase_source_too_long');
  }

  const images = readImages(b.images);
  if (images === 'invalid') fail('images', 'image_invalid');
  const jan = strOpt(b.jan_code);
  if (jan !== undefined && jan.length > PRODUCT_MAX_CHARS.jan_code) {
    fail('jan_code', 'jan_code_invalid');
  }
  if (hs !== undefined && hs.length > PRODUCT_MAX_CHARS.hs_code) {
    fail('hs_code', 'hs_code_too_long');
  }

  if (errors.length > 0 || title === undefined || price === undefined || weight === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      title,
      category: String(category),
      ...(strOpt(b.description) !== undefined ? { description: strOpt(b.description) } : {}),
      images: images === 'invalid' ? [] : images,
      price_jpy: price,
      ...(cost !== undefined ? { cost_jpy: cost } : {}),
      weight_g: weight,
      ...(stock !== undefined ? { stock } : {}),
      compliance_tags: tags,
      ...(hs !== undefined ? { hs_code: hs } : {}),
      customs_desc_en: desc ?? '',
      origin_country: 'JP',
      ...(strOpt(b.title_ja) !== undefined ? { title_ja: strOpt(b.title_ja) } : {}),
      ...(jan !== undefined ? { jan_code: jan } : {}),
      ...(strOpt(b.purchase_source) !== undefined
        ? { purchase_source: strOpt(b.purchase_source) }
        : {}),
    },
  };
}
