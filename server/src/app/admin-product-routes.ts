/**
 * 职责：管理端商品端点（I2 U-A3）——`GET/POST /admin/products`、
 *      `PUT /admin/products/{id}`、`PATCH /admin/products/{id}/status`、
 *      `PATCH /admin/products/{id}/stock`（列表内联改库存，AJ-403）。
 *
 * @why 四条路由共用**一个** `requireAdmin` 守卫实例，而不是每条各写一遍：
 *      守卫抄四遍，将来"要不要加一条审计"就得改四处，漏一处就是
 *      "某条管理端接口没有审计"——而这种漏法不会报错。
 *
 * @why 响应**不带 `display`**（展示价）：管理端是 JPY 后台，展示价是买家侧概念；
 *      为了凑满 `AdminProduct extends Product` 的 schema 去装配一份 fx 查询，
 *      等于为用不到的字段引入第二个汇率装配点（ADR-28：不写死、也不重复）。
 *      契约里 `display` 不是 required，省略合法。
 *
 * @limitation 一：**字段级错误目前只进日志，不透给前端**。契约 `Err` 只有
 *              `{code, message}`，`AppError.details` 按设计只写日志（errors.ts @security）。
 *              所以运营看到的是 40001 + 通用文案，具体哪个字段错要看日志。
 *              MVP 可接受是因为管理端前端（`admin-web/src/products/view.ts`）**先拦一次**：
 *              必填、整数、敏感词、`PRODUCT_MAX_CHARS` 的字数都在那里判，服务端这条多数走不到。
 * @limitation 一·补：⚠️ 但**不是"同一套"**（这里曾经这么写，与事实不符）：
 *              前端对 `price_jpy` 只判 `>= 1` 的整数（view.ts:343），**没有上界**，
 *              所以 `price_too_large` 这类"服务端独有"的校验命中时，前端无从拦起，
 *              运营只会看到 40001 + 通用文案、不知道是哪个字段。
 *              真要透传需扩契约 `Err` 加 `data`（登记为待办）。
 * @limitation 二：不做删除——`status='offline'` 即下架（商品被订单引用，删了订单说不清卖了什么）。
 *
 * @why 草稿（035 / AJ-403）：`POST` **恒建草稿**（请求体里的 status 一律忽略），上架只走 `PATCH /status`。
 *      @why 上架判定（P2-30 运费表 40918）因此只有**一处**入口：若 POST 也能直接建在售，
 *           判定就得在两处各写一遍，漏一处就是"超重商品从新建那条路直接上架"。
 *      @why 草稿只能是**起点**：PATCH 只收 active / offline，不收 draft——
 *           上过架的商品"不卖了"叫下架；退回草稿会让"它曾经卖过"这件事在状态上消失。
 *      @tradeoff 前端"保存并上架"要打两次请求（POST 再 PATCH）；第二步失败时商品已作为草稿存下，
 *                运营改好再点上架即可——比"一次失败两样都没有"更不丢活。
 *      @limitation 草稿与在售走**同一套**字段校验（不允许"先存一半"的不完整草稿）：
 *                  缺必填照样 40001。对标平台的草稿允许缺字段，我们没做——那要两套校验与"上架前补齐"检查。
 *
 * @see adapters/catalog-admin.ts（仓储）；domain/product-input.ts（校验）；
 *      contracts/api-contract.yaml（AdminProduct / ProductInput）
 */
import type { Express } from 'express';
import {
  LOW_STOCK_THRESHOLD,
  SEARCH_KEYWORD_MAX_LENGTH,
  LIST_SORT_KEYS,
  parseListSort,
} from '@waselect/shared';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { IdGen } from '../ports/ids.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { toImageSet } from './product-routes.js';
import {
  createCatalogAdminRepo,
  type AdminProductRow,
  type ProductStatus,
} from '../adapters/catalog-admin.js';
import { parseStockPatch } from '../domain/stock-patch.js';
import { validateProductInput } from '../domain/product-input.js';
import { fitsShippingTable } from '../domain/shipping-fit.js';
import { isImageId } from '../domain/upload-image.js';
import { setAuditTarget } from './admin-audit.js';

/** `PATCH /status` 可设的目标状态（草稿只能是起点，见文件头 @why）。改这里要同步契约 + 前端。 */
const PATCHABLE_STATUS = ['active', 'offline'] as const;
/** 列表 `?status=` 可筛的全部状态（035 / AJ-403 增 draft；与库约束 products_status_domain 同一词表）。 */
const LISTABLE_STATUS = ['active', 'offline', 'draft'] as const satisfies readonly ProductStatus[];

export interface AdminProductRoutesDeps {
  db: Db;
  logger: Logger;
  idGen: IdGen;
  config: AppConfig;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/**
 * 管理端的 `images` 条目 → 契约 ImageSet：**比买家侧多带一个 `image_id`**（0.6.29 / AJ-362）。
 *
 * @why 管理端必须**回显** id，这不是顺手加的字段，是"改存 image_id"这件事的**成立前提**——
 *      编辑页拿不到 id ⇒ 保存时只能发回三档 URL ⇒ 一次"只改标题的编辑"就把这个商品
 *      静默退回旧形态（业务表里又存回了存储位置），第一步的收益被**反向抹掉**，
 *      而且没有任何一方报错：运营看到的是"保存成功、图还在"。
 * @why 买家侧**不给** id（`toImageSet` 本身不带）：买家要的是可直接展示的 URL，
 *      id 对他没有用途；"同一个 ImageSet 两端长得不一样"由**谁需要**划分，
 *      不是图省事两端都给——两端都给的后果是契约里出现一个大部分消费者不认识的字段。
 * @why 三档 URL 仍然走 `toImageSet`（同一份映射）：只有"要不要附 id"这一层是管理端独有的，
 *      渲染逻辑与键形仍然只有一处；这里不重新实现"怎么拼 URL"。
 * @limitation 只有**按 id 存的**条目才有 `image_id`：存量条目是三档 URL，没有 id，
 *      前端据此保持旧形态提交（不会因为本次改动被改写成别的形状）。
 */
function toAdminImageSet(
  raw: unknown,
  imgBaseUrl: string | undefined,
): Record<string, unknown> | null {
  const set = toImageSet(raw, imgBaseUrl);
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = o['image_id'];
  // 没配展示域名（IMG_BASE_URL）时拼不出三档 URL，但 **id 仍要回显**（S-04）：
  // 原来整条被过滤掉，编辑页拿到空数组，运营只改个价格保存，PUT 就把库里的 image_id 覆盖成 []，不可恢复。
  if (set === null) return typeof id === 'string' && isImageId(id) ? { image_id: id } : null;
  // 判定复用 isImageId（domain/upload-image.ts 的单一真源）：本文件不另写一份"像 id 的样子"
  return typeof id === 'string' && isImageId(id) ? { ...set, image_id: id } : set;
}

/**
 * 仓储行 → 契约 AdminProduct（images 走 product-routes 的 ImageSet 映射，同一份逻辑）。
 * @param imgBaseUrl `config.IMG_BASE_URL`：条目按 image_id 存时要用它拼出可展示的 URL
 *      （0.6.28 / AJ-361；管理端列表/表单缩略图依赖这个，与买家侧同一份转换）。
 */
function toAdminProduct(
  r: AdminProductRow,
  imgBaseUrl: string | undefined,
): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    price_jpy: r.price_jpy,
    images: r.images.map((it) => toAdminImageSet(it, imgBaseUrl)).filter((s) => s !== null),
    stock: r.stock,
    status: r.status,
    ...(r.description !== null ? { description: r.description } : {}),
    weight_g: r.weight_g,
    compliance_tags: [...r.compliance_tags],
    ...(r.hs_code !== null ? { hs_code: r.hs_code } : {}),
    // ⚠️ NULL 时**整键省略**（与 hs_code 同口径），不能下发 `null`、更不能下发 "null"
    // @why 报关品名在 domain 层是必填，库里出现 NULL 只可能是绕过管理端的写入（CAT-20）。
    //      前端 `str('customs_desc_en')` 对"键不在"回落成空串 ⇒ 编辑页显示为未填 ⇒
    //      保存被 `英文报关品名必填（D-39）` 拦住，运营**必须补上**才能继续。
    //      若照旧 `String(null)` 给出字面量 "null"，则表单里是一串看着像内容的字符，
    //      校验放行、写回库，报关品名就此变成 "null"（改的人以为自己没动这一项）。
    ...(r.customs_desc_en !== null ? { customs_desc_en: r.customs_desc_en } : {}),
    origin_country: r.origin_country,
    ...(r.cost_jpy !== null ? { cost_jpy: r.cost_jpy } : {}),
    ...(r.title_ja !== null ? { title_ja: r.title_ja } : {}),
    ...(r.jan_code !== null ? { jan_code: r.jan_code } : {}),
    ...(r.purchase_source !== null ? { purchase_source: r.purchase_source } : {}),
    // 编辑口径三字段（020）：`why` / `maker` 为 null 时**整键省略**而不是给 null
    // @why 前端要区分"没写"（键不在）与"写了个空串"（键在、值空）——后者是脏数据，
    //      该被看见；而 null 与"键不在"在 JSON 里是两种东西，混成 null 会把脏数据洗白。
    //      `tags` 则恒给数组（DB 是 NOT NULL，只有"空数组"一种空态）。
    ...(r.why !== null ? { why: r.why } : {}),
    ...(r.maker !== null ? { maker: r.maker } : {}),
    tags: [...r.tags],
    updated_at: r.updated_at.toISOString(),
  };
}

/**
 * 校验失败 → 40001，字段明细写日志（@limitation 一）。
 * AJ-488（契约 0.6.73）：响应 `data` 带**第一个**出错的字段与原因码 + 出错总数——后台把售价填成 999,999
 * 只看到"参数缺失或格式错误"，运营不知道是哪一项。只给第一个：表单一次改一处，多给反而难排版；全部明细仍在日志。
 * @why 这是管理员接口，字段名与原因码不含任何买家数据，暴露无风险；原因码到人话的翻译在管理端（文案不进服务端）。
 */
function rejectInvalid(
  logger: Logger,
  errors: readonly { field: string; reason: string }[],
  maxPriceJpy: number,
): never {
  logger.warn('admin_product_input_rejected', {
    result: 'rejected',
    ctx: { errors },
  });
  const first = errors[0];
  throw new AppError(
    40001,
    { errors },
    first === undefined
      ? undefined
      : {
          field: first.field,
          reason: first.reason,
          count: errors.length,
          // 售价超限时带上上限：运营要知道"最多能填多少"（上限是服务端配置，前端不知道）
          ...(first.reason === 'price_too_large' ? { limit: maxPriceJpy } : {}),
        },
  );
}

/** 服务端下发的 `updated_at` 恒为 `toISOString()`：毫秒 + `Z`，别的一律不认。 */
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 取 `expected_updated_at`（乐观锁凭据）；缺失或不是合法时间 → 40001。
 *
 * @why 单独一个函数而不是内联两行：它是"这个 PUT 能不能被接受"的**准入判定**，
 *      形状校验、错误文案、日志三处必须一致，散在路由里改一处漏一处就会
 *      出现"带了凭据却说不合法"或"没带凭据也能保存"这两种各自都很难复现的洞。
 *
 * @why 两步校验（**形状 → 取值**）而不用 `new Date(x).toISOString()` 归一化：
 *      ① F10：业务侧不构造 `Date`（时钟与历法判定走 ports/clock，这条由 eslint 硬拦）；
 *      ② 服务端下发的就是这个形状，要求它"必须长这样"比"接受任何能被 parse 的东西"更严——
 *         `'2026-1-2'` 这种输入能被 parse，但解析结果随引擎而异，
 *         而**凭据对不上的代价是运营被无理由地赶回去刷新**；宁可响亮地 40001。
 *      `Date.parse` 那一步专治 `2026-13-99T00:00:00.000Z`（形状对、时间不存在）。
 *      @tradeoff 代价：只接受 UTC `Z` 尾，带时区偏移的合法 ISO（`+09:00`）会被拒。
 *              可接受——这个值的唯一生产者是服务端自己的 `toISOString()`。
 */
/**
 * 取 `expected_stock`（P2-8，AJ-386）：PUT 带 `stock` 时必填（≥0 整数），不带 `stock` 时忽略。
 * @why 与 `expected_updated_at` 同理"缺了就 40001"：无凭据的绝对值覆盖会抹掉期间的下单扣减。
 * @tradeoff 运营改库存那一刻恰好有人下单 → 40914 要刷新重填；比"多卖出不存在的货"便宜。
 */
export function expectedStockOf(body: unknown, sendsStock: boolean): number | undefined {
  if (!sendsStock) return undefined;
  const raw = (body as { expected_stock?: unknown } | undefined)?.expected_stock;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)
    throw new AppError(40001, { reason: 'expected_stock_required' });
  return raw;
}

export function expectedUpdatedAtOf(body: unknown): string {
  const raw = (body as { expected_updated_at?: unknown } | undefined)?.expected_updated_at;
  if (typeof raw !== 'string' || raw === '') {
    throw new AppError(40001, { reason: 'expected_updated_at_required' });
  }
  if (!ISO_MS_Z.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new AppError(40001, { reason: 'expected_updated_at_invalid' });
  }
  return raw;
}

export function mountAdminProductRoutes(app: Express, deps: AdminProductRoutesDeps): void {
  const repo = createCatalogAdminRepo(deps.db);

  /**
   * P2-30：在售商品"单件 + 包材"必须落在当前生效运费表的最高档内，否则 40918。
   * @why 放在上架 / 改在售 / 重新上架三处，而不是报价时：报价时才发现，是买家已经加购了。
   */
  const assertFitsShipping = async (productId: string | null, weightG: number): Promise<void> => {
    const maxTier = await repo.maxActiveShippingTierG();
    if (fitsShippingTable(weightG, deps.config.PACKAGING_WEIGHT_G, maxTier)) return;
    const details = {
      product_id: productId,
      weight_g: weightG,
      packaging_weight_g: deps.config.PACKAGING_WEIGHT_G,
      max_tier_weight_g: maxTier,
    };
    deps.logger.warn('admin_product_overweight_for_shipping', { result: 'rejected', ctx: details });
    throw new AppError(40918, details);
  };
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const imgBase = deps.config.IMG_BASE_URL;

  app.get('/api/v1/admin/products', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = req.query as {
          status?: unknown;
          page?: unknown;
          size?: unknown;
          keyword?: unknown;
          low_stock?: unknown;
        };
        const page = q.page === undefined ? 1 : Number(q.page);
        const size = q.size === undefined ? 50 : Number(q.size);
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > 100
        ) {
          throw new AppError(40001, { reason: 'page_size_invalid' });
        }
        const status = q.status === undefined ? undefined : String(q.status);
        if (status !== undefined && !(LISTABLE_STATUS as readonly string[]).includes(status)) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        // 搜索与低库存（三端联动 UI 模拟 2026-10-08）：上限与订单搜索同一个 shared 常量
        const keyword = typeof q.keyword === 'string' ? q.keyword.trim() : '';
        if (keyword.length > SEARCH_KEYWORD_MAX_LENGTH) {
          throw new AppError(40001, { reason: 'keyword_too_long' });
        }
        if (q.low_stock !== undefined && q.low_stock !== 'true' && q.low_stock !== 'false') {
          throw new AppError(40001, { reason: 'low_stock_invalid' });
        }
        // 评估 4.5（契约 0.6.53）：白名单排序；非法 → 40001
        const sort = parseListSort((req.query as { sort?: unknown }).sort, LIST_SORT_KEYS.products);
        if (!sort.ok) throw new AppError(40001, { reason: sort.reason });
        const { items, total } = await repo.listAdminProducts({
          page,
          size,
          status: status as ProductStatus | undefined,
          ...(keyword !== '' ? { keyword } : {}),
          ...(q.low_stock === 'true' ? { lowStockAt: LOW_STOCK_THRESHOLD } : {}),
          ...(sort.key !== null ? { sort: { key: sort.key, dir: sort.dir } } : {}),
        });
        res.json({ items: items.map((r) => toAdminProduct(r, imgBase)), total });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/products', guard, (req, res, next) => {
    void (async () => {
      try {
        const r = validateProductInput(req.body, deps.config.MAX_ORDER_JPY);
        if (!r.ok) rejectInvalid(deps.logger, r.errors, deps.config.MAX_ORDER_JPY);
        // 不判 P2-30：新建是草稿，买家看不见；判定在 PATCH /status → active 那一步（AJ-403）
        const row = await repo.insertProduct({
          id: deps.idGen.uuid(),
          title: r.value.title,
          category: r.value.category,
          description: r.value.description ?? null,
          images: r.value.images,
          price_jpy: r.value.price_jpy,
          cost_jpy: r.value.cost_jpy ?? null,
          weight_g: r.value.weight_g,
          stock: r.value.stock ?? 0, // 新建：省略即 0（预售/缺货上架是正常动作）
          compliance_tags: r.value.compliance_tags,
          hs_code: r.value.hs_code ?? null,
          customs_desc_en: r.value.customs_desc_en,
          origin_country: r.value.origin_country,
          title_ja: r.value.title_ja ?? null,
          jan_code: r.value.jan_code ?? null,
          purchase_source: r.value.purchase_source ?? null,
          status: 'draft', // AJ-403：恒建草稿，请求体里的 status 忽略（见文件头）
          // 编辑口径三字段（020）：省略 → null / []（"还没撰写"，前端降级）
          why: r.value.why ?? null,
          maker: r.value.maker ?? null,
          tags: r.value.tags ?? [],
        });
        // 新建没有路径 `:id`，审计的 target 会是 NULL ⇒ 审计行回答不了"建的是哪个商品"（SEC-12 / AJ-344）
        setAuditTarget(res, row.id);
        res.status(201).json(toAdminProduct(row, imgBase));
      } catch (e) {
        next(e);
      }
    })();
  });

  app.put('/api/v1/admin/products/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const r = validateProductInput(req.body, deps.config.MAX_ORDER_JPY);
        if (!r.ok) rejectInvalid(deps.logger, r.errors, deps.config.MAX_ORDER_JPY);
        // ── 乐观锁凭据（ADM3-02 / AJ-258，契约 0.6.18）───────────────────────────
        // ⚠️ 必须在 `validateProductInput` **之后**单独取：它不属于 `ProductInput`
        //    （商品字段与"你看到的是哪一版"是两件事，混进同一个 schema 会让
        //     "改一个字段"与"改的哪一版"在日志里说不清）。
        // @why 缺了就 40001 而不是"退化成无锁更新"：无锁 = 静默覆盖他人改价，
        //      那正是本条要堵的洞；宁可让不带凭据的旧前端**响亮失败**，
        //      也不要它继续"能用"——能用但会丢别人的改动，比不能用危险得多。
        const expected = expectedUpdatedAtOf(req.body);
        const expectedStock = expectedStockOf(req.body, r.value.stock !== undefined);
        // 只判**在售**的：下架中允许先把真实重量录进来，重新上架时再判（PATCH /status）
        const current = await repo.findStatusAndWeight(id);
        if (current?.status === 'active') await assertFitsShipping(id, r.value.weight_g);
        const result = await repo.updateProduct(id, {
          expectedUpdatedAt: expected,
          ...(expectedStock !== undefined ? { expectedStock } : {}),
          id,
          title: r.value.title,
          category: r.value.category,
          description: r.value.description ?? null,
          images: r.value.images,
          price_jpy: r.value.price_jpy,
          cost_jpy: r.value.cost_jpy ?? null,
          weight_g: r.value.weight_g,
          // 省略 = 不改库存；status 不在 PUT 的职责内（上下架只走 PATCH /status）——AJ-175
          ...(r.value.stock !== undefined ? { stock: r.value.stock } : {}),
          compliance_tags: r.value.compliance_tags,
          hs_code: r.value.hs_code ?? null,
          customs_desc_en: r.value.customs_desc_en,
          origin_country: r.value.origin_country,
          title_ja: r.value.title_ja ?? null,
          jan_code: r.value.jan_code ?? null,
          purchase_source: r.value.purchase_source ?? null,
          // PUT 是整行覆盖，三字段**必须显式给值**（与 stock 的"省略即不改"相反）：
          // 运营删掉 why 保存 = 真的清空，而不是"保留上一次写的"。
          why: r.value.why ?? null,
          maker: r.value.maker ?? null,
          tags: r.value.tags ?? [],
        });
        if (!result.ok) {
          if (result.reason === 'not_found') throw new AppError(40401, { product_id: id });
          // 40914：库里那一行在运营打开表单之后被改过了。整行**没有写**（0 行命中）。
          // @why 要留一条 warn 而不是只回码：这是"两个人同一分钟改同一件商品"的唯一信号，
          //      没有它，将来评估"要不要改成字段级合并"时没有任何数据可用。
          deps.logger.warn('admin_product_update_stale', {
            result: 'conflict',
            ctx: {
              product_id: id,
              expected,
              expected_stock: expectedStock,
              action: 'none（未写入）',
            },
          });
          throw new AppError(40914, { product_id: id, expected });
        }
        res.json(toAdminProduct(result.row, imgBase));
      } catch (e) {
        next(e);
      }
    })();
  });

  app.patch('/api/v1/admin/products/:id/status', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const status = (req.body as { status?: unknown } | undefined)?.status;
        if (
          typeof status !== 'string' ||
          !(PATCHABLE_STATUS as readonly string[]).includes(status)
        ) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        if (status === 'active') {
          const current = await repo.findStatusAndWeight(id);
          if (current !== null) await assertFitsShipping(id, current.weightG);
        }
        const hit = await repo.setProductStatus(id, status as 'active' | 'offline');
        if (!hit) throw new AppError(40401, { product_id: id });
        res.json({ id, status });
      } catch (e) {
        next(e);
      }
    })();
  });

  /**
   * 列表内联改库存（AJ-403）：`{stock, expected_stock}`，库存已不是 expected_stock → 40914。
   * @why 窄接口而不是整行 PUT：列表行改库存若走 PUT，就得带齐全部字段与 `expected_updated_at`——
   *      别人改了一下标题，改库存就无辜 40914；而库存真正要护住的只有"期间被下单扣减"这一件事。
   * @why 不推进 `updated_at`（仓储 setStock 的 @why）：正在编辑同一商品的人不会因此 40914，列表也不跳行。
   *      编辑页若同时改了库存，它带的 expected_stock 会对不上 → 40914，那正是该拦的冲突。
   * @limitation 状态不限：草稿 / 下架商品也能改库存（备货本来就在上架之前）。
   */
  app.patch('/api/v1/admin/products/:id/stock', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const p = parseStockPatch(req.body);
        if (!p.ok) throw new AppError(40001, { reason: p.reason });
        const result = await repo.setStock(id, p.stock, p.expectedStock);
        if (!result.ok) {
          if (result.reason === 'not_found') throw new AppError(40401, { product_id: id });
          deps.logger.warn('admin_product_stock_stale', {
            result: 'conflict',
            ctx: { product_id: id, expected_stock: p.expectedStock, action: 'none（未写入）' },
          });
          throw new AppError(40914, { product_id: id, expected_stock: p.expectedStock });
        }
        res.json({ id, stock: p.stock });
      } catch (e) {
        next(e);
      }
    })();
  });
}
