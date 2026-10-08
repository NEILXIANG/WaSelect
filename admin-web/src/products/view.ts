/**
 * 职责：商品管理的**视图纯函数**（列表行 / 表单模型 / 校验 / 请求体）。
 *
 * @why 管理端与小程序同一条纪律（CLAUDE.md 约束十一的同构要求）：
 *      逻辑抽成纯函数，才能把"十几个字段 × 各种空值与边界"写成**边界表**逐条断言；
 *      写在 `.tsx` 里就只剩"人肉点一遍"。
 *      ⚠️ 2026-10-01 订正（ADM3-07）：原写"unit 层是 node 环境、没有 jsdom / React Testing
 *      Library"——`testing/dom.ts` 落地后 jsdom 组件用例已可跑（本目录就有 `*.dom.unit.test.ts`），
 *      那句已不是事实。真实理由是成本：组件用例要挂载、等异步、断言依赖 DOM 结构，
 *      而校验这类"输入 → 通过/报错"的判定用表格写就是几行。结论不变，理由换成真的。
 *
 * @why 前端要**重复一遍**服务端的上架校验（禁售标签、报关品名敏感词）：
 *      商品表单十几个字段，让运营提交后才知道"这个标签不能上架"是纯浪费——
 *      一次往返换一条客户端本来就知道的信息。
 *      ⚠️ 但**服务端仍是权威**：这里是"预检"，不是"放行"；
 *      两处名单不一致由单测与 shared / 契约的双向比对钉住。
 *
 * @limitation 一：分类展示名落**本文件**而不是服务端下发——契约只给 key。
 *              分类 **key** 自第三轮缺口 §4 起从 shared 引（`PRODUCT_CATEGORY`），不再自备一份；
 *              但**展示名**仍与小程序 `pages/home/index.vm.js` 的 CATEGORY_LABELS 是**两份真源**
 *              （daily 两端统一叫「生活百货」，用户 2026-10-07 拍板），
 *              由各自的"与契约 enum 双向比对"守着；多语言（本项目有 zh/ja/en）落地时
 *              两处要一起改成下发式，届时这条 @limitation 应被删除。
 * @limitation 二：**不做图片裁剪/尺寸校验**（那是 `POST /admin/upload` 与 R2 的事），
 *              本层只按契约 `ImageSet` 的形状（thumb/card/detail）收口。
 *
 * @see ../../../contracts/api-contract.yaml（ProductInput / AdminProduct）；
 *      packages/shared/src/enums.ts（COMPLIANCE_TAG / BLOCKED_COMPLIANCE_TAG 真源）
 */
import {
  BLOCKED_COMPLIANCE_TAG,
  LOW_STOCK_THRESHOLD,
  COMPLIANCE_TAG,
  PRODUCT_CATEGORY,
  PRODUCT_MAX_CHARS,
  PRODUCT_MAX_WEIGHT_G,
  type ProductCategory,
} from '@waselect/shared';
import { moneyText } from '../format.js';

/** 商品状态（契约 `/admin/products` 的 status 枚举）。 */
export const PRODUCT_STATUS = ['active', 'offline'] as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[number];

/**
 * 分类（与契约 `/products` 的 category 枚举逐字一致，单测双向比对）。
 * @why 从 shared 再导出而不是自备一份（第三轮缺口 §4）：三端同一个枚举只该有一处定义。
 */
export { PRODUCT_CATEGORY, type ProductCategory };

/** 分类展示名（@see @limitation 一）。 */
export const CATEGORY_LABELS: Readonly<Record<ProductCategory, string>> = {
  beauty: '美妆护肤',
  daily: '生活百货', // 与小程序同名（用户 2026-10-07 拍板）
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
  /**
   * 首图缩略图地址（三端联动模拟 2026-10-08：列表原先没有图，运营只能靠文字认商品）；无图为空串。
   * 只收 http(s)——脏值不进 `<img src>`。
   */
  thumb: string;
  /** 库存 ≤ shared LOW_STOCK_THRESHOLD（列表标红）。 */
  lowStock: boolean;
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
        // 与订单页同一个格式化（千分位 + 円；非整数显示 —），P2-52
        priceText: moneyText(p['price_jpy']),
        stockText: Number.isInteger(p['stock']) ? String(p['stock']) : '—',
        thumb: firstThumb(p['images']),
        lowStock: Number.isInteger(p['stock']) && (p['stock'] as number) <= LOW_STOCK_THRESHOLD,
        ...statusFields(status),
      };
    });
}

/** 首图的 thumb 档（AdminProduct.images[0].thumb）；拿不到或不是 http(s) → 空串。 */
function firstThumb(images: unknown): string {
  const first = Array.isArray(images)
    ? (images[0] as Record<string, unknown> | undefined)
    : undefined;
  const t = first?.['thumb'];
  return typeof t === 'string' && /^https?:\/\//.test(t) ? t : '';
}

/**
 * 由 `status` 推出的三个展示字段——**只在这一处算**（AJ-231）。
 * @why 列表行里 `status` / `statusText` / `online` 是同一件事的三种写法。
 *      乐观更新曾经只手改其中两个（`online`、`status`），`statusText` 留在旧值：
 *      下架之后状态列仍写"在售"、按钮却变成"上架"，运营以为没生效再点一次，就把商品重新上架了。
 *      三个字段一起出，就不存在"改了两个忘了第三个"。
 */
function statusFields(status: ProductStatus): Pick<ProductRow, 'status' | 'statusText' | 'online'> {
  return {
    status,
    statusText: status === 'active' ? '在售' : '已下架',
    online: status === 'active',
  };
}

/** 把一行改成指定状态（乐观更新与失败回滚都用它；不改其它字段）。 */
export function withStatus(row: ProductRow, status: ProductStatus): ProductRow {
  return { ...row, ...statusFields(status) };
}

/**
 * 合规标签中文名（三端联动 UI 模拟 2026-10-08：原先直接显示 liquid / quasi_drug 等代码，运营看不懂）。
 * 键与 shared COMPLIANCE_TAG 一一对应；漏一个时界面退回显示代码（看得见，不静默）。
 */
export const COMPLIANCE_TAG_LABELS: Readonly<Record<string, string>> = {
  liquid: '液体',
  battery: '含电池',
  cosmetic: '化妆品',
  food: '食品',
  flammable: '易燃品',
  aerosol: '喷雾 / 气雾',
  electrical: '电器',
  quasi_drug: '医药部外品',
  sunscreen: '防晒（SPF）',
  children_product: '儿童用品',
  alcohol: '含酒精',
};

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
  /**
   * **`compliance_tags`** 的勾选集（**已去禁售标签**：禁售标签勾了也提交不出去）。
   *
   * @why 字段名带 **compliance** 前缀而不是叫 `tags`（2026-10-05 改名，020 迁移引入
   *      编辑口径的 `tags` 之后）：契约 `ProductInput` 里现在同时有
   *      `compliance_tags`（能不能寄，封闭枚举）与 `tags`（值不值得买，自由文案），
   *      而 `toProductInput` 会在**相邻两行**分别输出它们。
   *      若表单里仍叫 `tags`，那两行就是 `compliance_tags: f.tags` 与 `tags: f.editorialTags`
   *      ——哪天有人写快了打成 `tags: f.tags`，编译照样过、
   *      禁售枚举会被当成卖点文案**直接印在买家看到的卡片上**。
   *      带上前缀之后这行错话**读起来就不对**，是能在 review 里被拦住的那种错。
   */
  complianceTags: string[];
  /**
   * 以下三项 = **编辑口径**（020 迁移新增的 `products.why` / `maker` / `tags`），
   * 与上面的 `complianceTags` **不是一回事**：
   * - `complianceTags` 管"**能不能寄**"：封闭枚举，勾错是合规风险；
   * - 这三项管"**值不值得买**"：自由文案，写在 `pick-card` 上给买家看。
   *
   * @why **必须**回传而不是让服务端"省略即不改"：
   *      `PUT /admin/products/{id}` 是**整行覆盖**（`stock` 那种"省略即保持"
   *      是给并发列单独开的口子，编辑口径三列不在其中）。
   *      表单不回传 = 运营改个价格保存，就把编辑撰写的 `why` 整条抹成 null，
   *      **而且不报错**——等发现时文案已经丢了，版本表里也找不回来
   *      （`order_events` 只记订单，商品没有历史版本）。
   */
  /** `products.why`：为什么值得买（一句带判断的话，≤200 字）。 */
  editorialWhy: string;
  /** `products.maker`：产地 / 工房 / 匠人名（≤120 字，与列宽逐字一致）。 */
  editorialMaker: string;
  /** `products.tags`：编辑标签（自由文案，如「南部铁器」「无添加」）。 */
  editorialTags: string[];
  /** 图片集（契约 ImageSet[]；来自 `/admin/upload` 与 `AdminProduct.images[]`）。 */
  images: ProductImageEntry[];
}

/**
 * 表单里的一张商品图。
 *
 * @why 从 0.6.29 / AJ-362 起，**提交的是 `image_id`（有它时），三档 URL 只留在表单里做预览**：
 *      业务表不该存存储位置（域名 / CDN 前缀）——那是 AJ-143 / AJ-361 的同一条理由。
 *      URL 仍在**本地**留着，是因为移除按钮与缩略图预览要它，而服务端读路径会重新拼出它们。
 * @why 有 `image_id` 时**必须**丢掉三档 URL 再提交：服务端把"id + 三档 URL"判为**混填**并拒
 *      （AJ-361：形状不唯一 ⇒ 不许替调用方猜）。所以这里不是"少发几个字段"的优化，是必须。
 * @limitation 存量条目（此刻库里已是三档 URL 的那些）**没有** `image_id` ⇒ 仍按 URL 提交，
 *      保持原形态不变；它们不会因为本次改动被"改写成"别的形状，也不会被自动迁移成 id。
 */
export interface ProductImageEntry {
  /** 三档的共同主键（0.6.28 起上传响应恒带）。存量条目没有它。 */
  image_id?: string;
  /** 仅用于表单**预览**；有 `image_id` 时不提交。 */
  thumb: string;
  card: string;
  detail: string;
}

/** 空表单（新建态）。 */
export function emptyProductForm(): ProductForm {
  return {
    title: '',
    category: PRODUCT_CATEGORY[0],
    priceJpy: '',
    costJpy: '',
    weightG: '',
    // 新建时留空（三端联动 UI 模拟 2026-10-08）：原先默认 '0'，运营点进去直接输入 30 得到 "030"，
    // 漏填则一上架就是售罄。留空 + 必填校验（productFormErrors 已有"库存必填"）
    stock: '',
    description: '',
    customsDescEn: '',
    originCountry: 'JP',
    hsCode: '',
    titleJa: '',
    janCode: '',
    purchaseSource: '',
    complianceTags: [],
    editorialWhy: '',
    editorialMaker: '',
    editorialTags: [],
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
  /** 字符串数组（非数组 / 含非字符串 → 空数组，不抛）。 */
  const arr = (k: string): string[] =>
    Array.isArray(src[k])
      ? (src[k] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
  return {
    title: str('title'),
    category: str('category', PRODUCT_CATEGORY[0]),
    priceJpy: num('price_jpy'),
    costJpy: num('cost_jpy'),
    weightG: num('weight_g'),
    // 缺省留空（新建 = productFormModel(null)）：与 emptyProductForm 同口径，见那里的说明
    stock: num('stock', ''),
    description: str('description'),
    customsDescEn: str('customs_desc_en'),
    originCountry: str('origin_country', 'JP'),
    hsCode: str('hs_code'),
    titleJa: str('title_ja'),
    janCode: str('jan_code'),
    purchaseSource: str('purchase_source'),
    complianceTags: arr('compliance_tags'),
    // 编辑口径三列（020）：服务端键名就是 `why` / `maker` / `tags`（无前缀）——
    // 契约里它们与 `compliance_tags` 分居 ProductCard 与 ProductInput 两处，
    // 前缀只在**本文件的表单模型**里存在（@see ProductForm.complianceTags 的 @why）。
    editorialWhy: str('why'),
    editorialMaker: str('maker'),
    editorialTags: arr('tags'),
    images: Array.isArray(src['images'])
      ? (src['images'] as unknown[]).map((img) => {
          const o = (typeof img === 'object' && img !== null ? img : {}) as Record<string, unknown>;
          const id = typeof o['image_id'] === 'string' && o['image_id'] !== '' ? o['image_id'] : '';
          return {
            // ⚠️ 空串当"没有"：服务端 0.6.29 起只在条目按 id 存时回显它，
            //    存量条目没有这个键；补个空串进去会让下面的提交逻辑以为有 id。
            ...(id !== '' ? { image_id: id } : {}),
            thumb: typeof o['thumb'] === 'string' ? o['thumb'] : '',
            card: typeof o['card'] === 'string' ? o['card'] : '',
            detail: typeof o['detail'] === 'string' ? o['detail'] : '',
          };
        })
      : [],
  };
}

/**
 * 编辑态的**乐观锁凭据**：`source.updated_at`（服务端那一行最后被改的时刻）。
 *
 * @why 单独一个函数而不是塞进 `ProductForm`：它不是**运营填的字段**，
 *      "商品长什么样"与"你看到的是哪一版"是两件事，混进表单模型会让
 *      `toProductInput` 把它当成一个可编辑字段一起提交（而它不是商品属性），
 *      也会让 `productFormErrors` 为它操心。它是 PUT 的准入凭据，只在提交那一刻用。
 * @why 取不到时返回 `''` 而不是 `undefined`：空串会让服务端明确回 40001
 *      （"缺 expected_updated_at"），而 `undefined` 会被 `JSON.stringify` 直接删掉字段，
 *      服务端收到的是"没带"——两种失败在日志里长得不一样，空串留的线索更多。
 */
export function sourceUpdatedAt(p: unknown): string {
  const src = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
  return typeof src['updated_at'] === 'string' ? (src['updated_at'] as string) : '';
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
    complianceTags: Array.isArray(f['complianceTags'])
      ? (f['complianceTags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : base.complianceTags,
    editorialWhy: str('editorialWhy', base.editorialWhy),
    editorialMaker: str('editorialMaker', base.editorialMaker),
    editorialTags: Array.isArray(f['editorialTags'])
      ? (f['editorialTags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : base.editorialTags,
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
/**
 * 表单**顶部**那条错误提示的文案。
 *
 * @why 不能直接拿 `first` 当顶部文案（2026-10-08 实机缺陷）：
 *      每条错误的详细原因已经显示在各自输入框的正下方，顶部再原样写一遍
 *      「商品名必填」，同一个句子在同一屏出现两次——运营会以为有两个同名商品名字段，
 *      或者以为上面那条是"另一处还没改"。
 * @why 多条时只报条数、不报内容：顶部条的作用是"这一屏还没完"的总控信号，
 *      具体内容属于出错的那一行；一条时（没有聚合的必要）照旧给原文，不让信息量变少。
 * @limitation 条数按 `errors` 的键数算，所以它假定**每个键都有对应字段在表单里显示出来**；
 *             一旦加了"只在顶部提示"的错误类型，这里要跟着改。
 */
export function productFormSummary(errors: Record<string, string>, first: string): string {
  const n = Object.keys(errors).length;
  return n > 1 ? `有 ${String(n)} 项需要修正（见下方标红的字段）` : first;
}

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

  // ⚠️ 数值一律走 `plainInt`（P2-51）：`Number('1e3') === 1000` 是整数，旧写法会放行科学计数法，
  //    而 `<input type="number">` 恰恰允许输入 e——运营手滑多按一个 e，售价就成了另一个数。
  const price = plainInt(f.priceJpy);
  if (price === null || price < 1)
    errors['priceJpy'] = `售价必须是 ≥1 的整数（円）${sciHint(f.priceJpy)}`;
  if (f.costJpy.trim() !== '') {
    const cost = plainInt(f.costJpy);
    if (cost === null) errors['costJpy'] = `成本价必须是 ≥0 的整数（円）${sciHint(f.costJpy)}`;
  }
  const weight = plainInt(f.weightG);
  if (weight === null || weight < 1)
    errors['weightG'] = `重量必须是 ≥1 的整数（克，含包材口径见 D-42）${sciHint(f.weightG)}`;
  // 上界与服务端 weight_too_large 同源（shared；工程缺口第二轮 §3.6 #1 起已为包材留出余量）
  else if (weight > PRODUCT_MAX_WEIGHT_G)
    errors['weightG'] =
      `单件重量最多 ${PRODUCT_MAX_WEIGHT_G} 克（再重就超出运费表最大档，无法下单）`;
  // 先判空（A-06）：`Number('') === 0`，清空库存框会被当成 0 提交，商品直接售罄
  if (f.stock.trim() === '') errors['stock'] = '库存必填（≥0 的整数；真的卖完了请填 0）';
  else if (plainInt(f.stock) === null) errors['stock'] = `库存必须是 ≥0 的整数${sciHint(f.stock)}`;

  if (f.customsDescEn.trim() === '') errors['customsDescEn'] = '英文报关品名必填（D-39）';
  // 剩余清单 1-4（AJ-368）：与服务端 validateProductInput 同口径——所有商品必填，纯空白算没填
  if (f.hsCode.trim() === '') errors['hsCode'] = 'HS 编码必填（报关单与报关清单都要用）';
  else if (!hsCodeShapeOk(f.hsCode))
    errors['hsCode'] =
      'HS 编码只能是数字（可用点号分段），共 6–10 位数字，如 6912.00 或 3304995000';
  if (f.originCountry !== 'JP') errors['originCountry'] = 'MVP 原产地只接受 JP（D-42/D-43）';

  // 禁售标签：shared 是真源，这里只做"勾了就报"（比"勾了提交被拒"早一步）
  const blocked = f.complianceTags.filter((t) =>
    (BLOCKED_COMPLIANCE_TAG as readonly string[]).includes(t),
  );
  if (blocked.length > 0) errors['complianceTags'] = `这些标签上架即拒：${blocked.join('、')}`;
  const unknown = f.complianceTags.filter(
    (t) => !(COMPLIANCE_TAG as readonly string[]).includes(t),
  );
  if (unknown.length > 0) errors['complianceTags'] = `不在契约枚举内的标签：${unknown.join('、')}`;

  // ── 文本列长度预检（工程缺口第二轮 §3.6 #2）────────────────────────────────
  // @why 上限从 shared 取（与列宽、服务端判定同源）。超长原先只能等提交被拒，拿到的是泛化 40001，
  //      reason 只进日志——运营看不出是哪一栏。已有错误（如必填）时不覆盖。
  const LENGTH_CHECKS = [
    ['title', f.title, PRODUCT_MAX_CHARS.title, '商品名'],
    ['customsDescEn', f.customsDescEn, PRODUCT_MAX_CHARS.customs_desc_en, '英文报关品名'],
    ['hsCode', f.hsCode, PRODUCT_MAX_CHARS.hs_code, 'HS 编码'],
    ['titleJa', f.titleJa, PRODUCT_MAX_CHARS.title_ja, '日文品名'],
    ['janCode', f.janCode, PRODUCT_MAX_CHARS.jan_code, 'JAN 码'],
    ['purchaseSource', f.purchaseSource, PRODUCT_MAX_CHARS.purchase_source, '采购来源'],
  ] as const;
  for (const [key, value, max, label] of LENGTH_CHECKS) {
    if (errors[key] === undefined && value.length > max)
      errors[key] = `${label}最多 ${max} 字（当前 ${value.length} 字）`;
  }

  // ── 编辑口径三列的预检（020）───────────────────────────────────────────────
  // @why 上限**从 shared 取**而不是在这里写 200 / 120：写死就等于把
  //      `product-domain.ts` 的 `why_too_long` 判定复制了一份，改一处漏一处时
  //      运营会在"填到第 201 字提交被拒"上卡住，而错误文案是泛化的 40001。
  // @why 编辑标签**只查空串**：它不像合规标签有枚举（自由文案是本意），
  //      但空串标签会被服务端判 `tags_invalid` 拒掉整条请求。
  if (f.editorialWhy.length > PRODUCT_MAX_CHARS.why)
    errors['editorialWhy'] =
      `「为什么值得买」最多 ${PRODUCT_MAX_CHARS.why} 字（当前 ${f.editorialWhy.length} 字）`;
  if (f.editorialMaker.length > PRODUCT_MAX_CHARS.maker)
    errors['editorialMaker'] =
      `产地/工房最多 ${PRODUCT_MAX_CHARS.maker} 字（当前 ${f.editorialMaker.length} 字）`;
  if (f.editorialTags.some((t) => t.trim() === ''))
    errors['editorialTags'] = '编辑标签不能有空标签（会被服务端判定为非法值）';

  // 报关品名敏感词（D-51：会被美国 FDA 当成功效宣称 / OTC 药品）
  const lower = f.customsDescEn.toLowerCase();
  const hit = BLOCKED_CUSTOMS_WORDS.filter((w) => lower.includes(w));
  if (hit.length > 0)
    errors['customsDescEn'] = `英文报关品名含敏感词 ${hit.join('、')}（会被判定为药品/功效宣称）`;

  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/** 十进制非负整数字符串 → 数；空 / 小数 / 负数 / 科学计数法 / 十六进制 → null（与 ops/view.ts parseCount 同口径）。 */
function plainInt(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** 填了 e / E 时补一句"不要用科学计数法"，否则运营看不出 1e3 哪里不是整数。 */
function sciHint(raw: string): string {
  return /e/i.test(raw) ? '；不要用科学计数法（如 1e3）' : '';
}

/**
 * HS 编码形状（P2-51）：数字，可用点号分段，数字合计 6–10 位（国际 6 位 → 美国 HTS 10 位）。
 * @why 服务端只判"填没填"（product-input.ts @limitation 二），"3304,99" "HS3304" 这类录入会原样进报关单。
 * @why 列宽 16（迁移 031，AJ-386）：带点号的 10 位 HTS（`3304.99.5000`，12 字符）可原样录入，与报关代理写法一致。
 * @limitation 点号位置不校验（`33.0499.5000` 也算合法）；只管"是数字、位数对"。
 */
export function hsCodeShapeOk(raw: string): boolean {
  const t = raw.trim();
  if (!/^\d+(\.\d+)*$/.test(t)) return false;
  const digits = t.replace(/\./g, '').length;
  return digits >= 6 && digits <= 10;
}

/**
 * **不拦截**的提醒（P2-51）：成本 ≥ 售价（每卖一件都亏）。
 * @why 不做成错误：清仓、赠品、引流款都可能故意亏本卖；但多数情况是把两个框填反了，值得提醒一眼。
 */
export function productFormWarnings(form: unknown): string[] {
  const f = asForm(form);
  const price = plainInt(f.priceJpy);
  const cost = f.costJpy.trim() === '' ? null : plainInt(f.costJpy);
  const out: string[] = [];
  if (price !== null && cost !== null && cost >= price)
    out.push(`采购成本（${cost} 円）不低于售价（${price} 円）：每卖一件都不赚钱，请确认没有填反`);
  return out;
}

/** 冲突对照的一行（40914 后"你填的 vs 最新值"）。 */
export interface ConflictRow {
  label: string;
  mine: string;
  latest: string;
  differs: boolean;
}

/**
 * 40914 后的对照表（P2-44）：表单当前值 vs 服务端最新一版，**逐字段**列出，标出不同的。
 * @why 原文案让运营"返回列表重新进入编辑"——那会**丢掉**整张表单（含已上传的图）。
 *      现在表单原地保留，最新值只读摆在旁边，运营自己决定保留哪边。
 * @limitation 图片只比**张数**（URL / id 逐张比对在这里没有可读的展示方式）。
 */
export function productConflictRows(form: unknown, latest: unknown): ConflictRow[] {
  const mine = asForm(form);
  const theirs = productFormModel(latest);
  const fields: Array<[string, keyof ProductForm]> = [
    ['商品名', 'title'],
    ['分类', 'category'],
    ['售价（円）', 'priceJpy'],
    ['采购成本（円）', 'costJpy'],
    ['重量（克）', 'weightG'],
    ['库存', 'stock'],
    ['英文报关品名', 'customsDescEn'],
    ['HS 编码', 'hsCode'],
    ['日文品名', 'titleJa'],
    ['JAN 码', 'janCode'],
    ['采购渠道', 'purchaseSource'],
    ['商品描述', 'description'],
    ['为什么值得买', 'editorialWhy'],
    ['产地 / 工房', 'editorialMaker'],
    ['编辑标签', 'editorialTags'],
    ['合规标签', 'complianceTags'],
  ];
  const text = (v: unknown): string => (Array.isArray(v) ? v.join('、') : String(v ?? ''));
  // 分类显示中文名（三端联动模拟 2026-10-08：对照表里原样显示 daily）
  const show = (key: keyof ProductForm, v: unknown): string =>
    key === 'category' ? (CATEGORY_LABELS[v as ProductCategory] ?? text(v)) : text(v);
  const rows = fields.map(([label, key]) => {
    const a = show(key, mine[key]);
    const b = show(key, theirs[key]);
    return { label, mine: a, latest: b, differs: a !== b };
  });
  const a = `${mine.images.length} 张`;
  const b = `${theirs.images.length} 张`;
  rows.push({ label: '图片', mine: a, latest: b, differs: a !== b });
  return rows;
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
    // P2-8（AJ-386）：改库存时带上"打开表单时看到的数"，期间被下单扣减过 → 服务端 40914，不会覆盖
    ...(stockChanged && originalStock !== undefined
      ? { expected_stock: Number(originalStock) }
      : {}),
    description: f.description.trim(),
    customs_desc_en: f.customsDescEn.trim(),
    origin_country: 'JP',
    hs_code: f.hsCode.trim(),
    title_ja: f.titleJa.trim(),
    jan_code: f.janCode.trim(),
    purchase_source: f.purchaseSource.trim(),
    compliance_tags: f.complianceTags,
    // ⚠️ 编辑口径三列**恒带**（含空数组 / 空串）：PUT 是整行覆盖，
    //    这里省略 = "把已撰写的内容清空"，而不是"我没改它"（@see ProductForm 的 @why）。
    //    `why` / `maker` 的"未撰写"由**空串**表达（服务端 `?? null` 只兜 undefined）。
    why: f.editorialWhy.trim(),
    maker: f.editorialMaker.trim(),
    tags: f.editorialTags.map((t) => t.trim()).filter((t) => t !== ''),
    // ⚠️ 有 `image_id` 时**只**发 id，三档 URL 一个都不带：服务端把"id + 三档 URL"
    //    判成**混填**并拒（AJ-361：形状不唯一，不许替调用方猜）。所以这不是"少发几个字段"，
    //    带着 URL 一起发会直接 40001。
    //    没有 id 的存量条目照旧发三档 URL，形态保持不变（不自动迁移，见 ProductImageEntry 的 @limitation）。
    images: f.images.map((img) =>
      img.image_id !== undefined && img.image_id !== ''
        ? { image_id: img.image_id }
        : { thumb: img.thumb, card: img.card, detail: img.detail },
    ),
  };
}
