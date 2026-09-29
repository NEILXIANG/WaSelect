/**
 * 职责：商品管理的**视图纯函数**（列表行 / 表单模型 / 校验 / 请求体）。
 *
 * @why 管理端与小程序同一条纪律（CLAUDE.md 约束十一的同构要求）：
 *      vitest 的 unit 层是 node 环境（没有 jsdom / React Testing Library），
 *      逻辑写在 `.tsx` 里就只剩"人肉点一遍"。抽成纯函数才能进门禁。
 *
 * @why 前端要**重复一遍**服务端的上架校验（禁售标签、报关品名敏感词）：
 *      商品表单十几个字段，让运营提交后才知道"这个标签不能上架"是纯浪费——
 *      一次往返换一条客户端本来就知道的信息。
 *      ⚠️ 但**服务端仍是权威**：这里是"预检"，不是"放行"；
 *      两处名单不一致由单测与 shared / 契约的双向比对钉住。
 *
 * @limitation 一：分类展示名落**本文件**而不是服务端下发——契约只给 key。
 *              与小程序 `pages/home/index.vm.js` 的 CATEGORY_LABELS 是**两份真源**，
 *              由各自的"与契约 enum 双向比对"守着；多语言（本项目有 zh/ja/en）落地时
 *              两处要一起改成下发式，届时这条 @limitation 应被删除。
 * @limitation 二：**不做图片裁剪/尺寸校验**（那是 `POST /admin/upload` 与 R2 的事），
 *              本层只按契约 `ImageSet` 的形状（thumb/card/detail）收口。
 *
 * @see ../../../contracts/api-contract.yaml（ProductInput / AdminProduct）；
 *      packages/shared/src/enums.ts（COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG 真源）
 */
import { BLOCKED_COMPLIANCE_TAG, COMPLIANCE_TAG } from '@waselect/shared';

/** 商品状态（契约 `/admin/products` 的 status 枚举）。 */
export const PRODUCT_STATUS = ['active', 'offline'] as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[number];

/** 分类（与契约 `/products` 的 category 枚举逐字一致，单测双向比对）。 */
export const PRODUCT_CATEGORY = ['beauty', 'daily', 'kitchen', 'food'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORY)[number];

/** 分类展示名（@see @limitation 一）。 */
export const CATEGORY_LABELS: Readonly<Record<ProductCategory, string>> = {
  beauty: '美妆护肤',
  daily: '日用杂货',
  kitchen: '厨房餐具',
  food: '食品',
};

/**
 * 报关英文品名里的**敏感词**：命中即拒（契约 ProductInput.customs_desc_en 的说明）。
 * @why 这五个词的共同点是"会被美国 FDA 当成药品/功效宣称"（D-51），
 *      而运营填英文品名时并不知道自己踩了线——预检把这条前置到输入那一刻。
 */
export const BLOCKED_CUSTOMS_WORDS = [
  'medicated',
  'whitening',
  'spf',
  'sunscreen',
  'drug',
] as const;

/** 列表行视图。 */
export interface ProductRow {
  id: string;
  title: string;
  categoryLabel: string;
  priceText: string;
  stockText: string;
  status: ProductStatus;
  statusText: string;
  /** true = 当前上架（列表页据此显示"下架"而不是"上架"）。 */
  online: boolean;
}

/**
 * `AdminProduct[]` → 列表行。
 * @why 状态文案只有两个值却仍走映射（不写 `status === 'active' ? '上架' : '下架'`）：
 *      契约新增状态时，三元表达式会**静默**把新值当成"下架"——
 *      而"一个已上架的新状态商品被显示成下架"会直接误导运营去重复上架。
 */
export function productRows(items: unknown): ProductRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .filter((p) => typeof p['id'] === 'string' && p['id'] !== '')
    .map((p) => {
      const status: ProductStatus = p['status'] === 'active' ? 'active' : 'offline';
      const category = p['category'];
      return {
        id: p['id'] as string,
        title: typeof p['title'] === 'string' ? p['title'] : '',
        categoryLabel:
          typeof category === 'string' && category in CATEGORY_LABELS
            ? CATEGORY_LABELS[category as ProductCategory]
            : ((category as string) ?? ''),
        priceText: Number.isInteger(p['price_jpy']) ? `${p['price_jpy']} 円` : '',
        stockText: Number.isInteger(p['stock']) ? String(p['stock']) : '—',
        status,
        statusText: status === 'active' ? '在售' : '已下架',
        online: status === 'active',
      };
    });
}

/** 商品表单模型（**全字符串**：受控输入的值恒为字符串，数值在提交时转）。 */
export interface ProductForm {
  title: string;
  category: string;
  priceJpy: string;
  costJpy: string;
  weightG: string;
  stock: string;
  description: string;
  customsDescEn: string;
  originCountry: string;
  hsCode: string;
  titleJa: string;
  janCode: string;
  purchaseSource: string;
  /** compliance_tags 的勾选集（**已去禁售标签**：禁售标签勾了也提交不出去）。 */
  tags: string[];
  /** 图片集（契约 ImageSet[]；来自 `/admin/upload`）。 */
  images: Array<{ thumb: string; card: string; detail: string }>;
}

/** 空表单（新建态）。 */
export function emptyProductForm(): ProductForm {
  return {
    title: '',
    category: PRODUCT_CATEGORY[0],
    priceJpy: '',
    costJpy: '',
    weightG: '',
    stock: '0',
    description: '',
    customsDescEn: '',
    originCountry: 'JP',
    hsCode: '',
    titleJa: '',
    janCode: '',
    purchaseSource: '',
    tags: [],
    images: [],
  };
}

/** `AdminProduct` → 表单模型（编辑态）。 */
export function productFormModel(p: unknown): ProductForm {
  const src = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
  const str = (k: string, fallback = ''): string =>
    typeof src[k] === 'string' ? (src[k] as string) : fallback;
  const num = (k: string, fallback = ''): string =>
    Number.isInteger(src[k]) ? String(src[k]) : fallback;
  return {
    title: str('title'),
    category: str('category', PRODUCT_CATEGORY[0]),
    priceJpy: num('price_jpy'),
    costJpy: num('cost_jpy'),
    weightG: num('weight_g'),
    stock: num('stock', '0'),
    description: str('description'),
    customsDescEn: str('customs_desc_en'),
    originCountry: str('origin_country', 'JP'),
    hsCode: str('hs_code'),
    titleJa: str('title_ja'),
    janCode: str('jan_code'),
    purchaseSource: str('purchase_source'),
    tags: Array.isArray(src['compliance_tags'])
      ? (src['compliance_tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    images: Array.isArray(src['images'])
      ? (src['images'] as unknown[]).map((img) => {
          const o = (typeof img === 'object' && img !== null ? img : {}) as Record<string, unknown>;
          return {
            thumb: typeof o['thumb'] === 'string' ? o['thumb'] : '',
            card: typeof o['card'] === 'string' ? o['card'] : '',
            detail: typeof o['detail'] === 'string' ? o['detail'] : '',
          };
        })
      : [],
  };
}

/**
 * 任意形状 → 表单模型（**只按 ProductForm 的键名读**）。
 *
 * @why 与 `productFormModel` 分开：后者读的是**服务端 `AdminProduct`** 的键名
 *      （`price_jpy` / `customs_desc_en`），前者读的是**表单自己的**键名（`priceJpy` / …）。
 *      校验与组装只接受 ProductForm——若在这两处再走一次 `productFormModel`，
 *      数值字段会**全部回落成空串**（表单里根本没有 `price_jpy` 这个键），
 *      表现为"编辑一个合法商品，保存时提示售价必填"，而错误指向表单不指向映射。
 *      ⚠️ 这个坑是单测抓出来的，不是推理出来的。
 */
function asForm(value: unknown): ProductForm {
  const base = emptyProductForm();
  const f = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const str = (k: string, fallback: string): string =>
    typeof f[k] === 'string' ? (f[k] as string) : fallback;
  return {
    ...base,
    title: str('title', base.title),
    category: str('category', base.category),
    priceJpy: str('priceJpy', base.priceJpy),
    costJpy: str('costJpy', base.costJpy),
    weightG: str('weightG', base.weightG),
    stock: str('stock', base.stock),
    description: str('description', base.description),
    customsDescEn: str('customsDescEn', base.customsDescEn),
    originCountry: str('originCountry', base.originCountry),
    hsCode: str('hsCode', base.hsCode),
    titleJa: str('titleJa', base.titleJa),
    janCode: str('janCode', base.janCode),
    purchaseSource: str('purchaseSource', base.purchaseSource),
    tags: Array.isArray(f['tags'])
      ? (f['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : base.tags,
    images: Array.isArray(f['images'])
      ? productFormModel({ images: f['images'] }).images
      : base.images,
  };
}

/**
 * 表单校验（入参是 `ProductForm`，不读服务端键名，@see asForm）。
 * @returns {{ok: boolean, errors: Record<string, string>, first: string}}
 * @why 返回**全部**错误而不是第一条：十几字段的表单一个一个报，运营要提交十几次。
 */
export function productFormErrors(form: unknown): {
  ok: boolean;
  errors: Record<string, string>;
  first: string;
} {
  const f = asForm(form);
  const errors: Record<string, string> = {};

  if (f.title.trim() === '') errors['title'] = '商品名必填';
  if (!PRODUCT_CATEGORY.includes(f.category as ProductCategory))
    errors['category'] = '请选择一个分类';

  const price = Number(f.priceJpy);
  if (!Number.isInteger(price) || price < 1) errors['priceJpy'] = '售价必须是 ≥1 的整数（円）';
  if (f.costJpy.trim() !== '') {
    const cost = Number(f.costJpy);
    if (!Number.isInteger(cost) || cost < 0) errors['costJpy'] = '成本价必须是 ≥0 的整数（円）';
  }
  const weight = Number(f.weightG);
  if (!Number.isInteger(weight) || weight < 1)
    errors['weightG'] = '重量必须是 ≥1 的整数（克，含包材口径见 D-42）';
  const stock = Number(f.stock);
  if (!Number.isInteger(stock) || stock < 0) errors['stock'] = '库存必须是 ≥0 的整数';

  if (f.customsDescEn.trim() === '') errors['customsDescEn'] = '英文报关品名必填（D-39）';
  if (f.originCountry !== 'JP') errors['originCountry'] = 'MVP 原产地只接受 JP（D-42/D-43）';

  // 禁售标签：shared 是真源，这里只做"勾了就报"（比"勾了提交被拒"早一步）
  const blocked = f.tags.filter((t) => (BLOCKED_COMPLIANCE_TAG as readonly string[]).includes(t));
  if (blocked.length > 0) errors['tags'] = `这些标签上架即拒：${blocked.join('、')}`;
  const unknown = f.tags.filter((t) => !(COMPLIANCE_TAG as readonly string[]).includes(t));
  if (unknown.length > 0) errors['tags'] = `不在契约枚举内的标签：${unknown.join('、')}`;

  // 报关品名敏感词（D-51：会被美国 FDA 当成功效宣称 / OTC 药品）
  const lower = f.customsDescEn.toLowerCase();
  const hit = BLOCKED_CUSTOMS_WORDS.filter((w) => lower.includes(w));
  if (hit.length > 0)
    errors['customsDescEn'] = `英文报关品名含敏感词 ${hit.join('、')}（会被判定为药品/功效宣称）`;

  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/**
 * 表单 → 契约 `ProductInput`。
 * @why `origin_country` **强制 JP** 而不是照抄表单：MVP 只允许 JP（D-42/D-43），
 *      表单里若出现别的值是脏数据，照抄会把"前端显示错了"升级成"服务端 40001"。
 */
export function toProductInput(form: unknown, originalStock?: string): Record<string, unknown> {
  const f = asForm(form);
  // 库存**只在变动时发送**（AJ-175）：库存是并发写的列（下单扣减、取消/关单回补），
  // 编辑页打开时读到的值在保存那一刻可能已经过时；原样带回去会把期间的扣减/回补覆盖掉。
  // 服务端约定：PUT 省略 stock = 保持原值。新建（originalStock 未传）照常发送。
  const stockChanged = originalStock === undefined || f.stock.trim() !== originalStock.trim();
  return {
    title: f.title.trim(),
    category: f.category,
    price_jpy: Number(f.priceJpy),
    cost_jpy: f.costJpy.trim() === '' ? undefined : Number(f.costJpy),
    weight_g: Number(f.weightG),
    ...(stockChanged ? { stock: Number(f.stock) } : {}),
    description: f.description.trim(),
    customs_desc_en: f.customsDescEn.trim(),
    origin_country: 'JP',
    hs_code: f.hsCode.trim(),
    title_ja: f.titleJa.trim(),
    jan_code: f.janCode.trim(),
    purchase_source: f.purchaseSource.trim(),
    compliance_tags: f.tags,
    images: f.images,
  };
}
