/**
 * 职责：管理端商品端点（I2 U-A3）——`GET/POST /admin/products`、
 *      `PUT /admin/products/{id}`、`PATCH /admin/products/{id}/status`。
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
 * @see adapters/catalog-admin.ts（仓储）；domain/product-input.ts（校验）；
 *      contracts/api-contract.yaml（AdminProduct / ProductInput）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { IdGen } from '../ports/ids.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { toImageSet } from './product-routes.js';
import { createCatalogAdminRepo, type AdminProductRow } from '../adapters/catalog-admin.js';
import { validateProductInput } from '../domain/product-input.js';
import { isImageId } from '../domain/upload-image.js';
import { setAuditTarget } from './admin-audit.js';

/** 契约 `PATCH status` 的两值枚举（下线不发版这条要改时，改这里 + 契约 + 前端三处）。 */
const PRODUCT_STATUS = ['active', 'offline'] as const;

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

/** 校验失败 → 40001，字段明细写日志（@limitation 一）。 */
function rejectInvalid(
  logger: Logger,
  errors: readonly { field: string; reason: string }[],
): never {
  logger.warn('admin_product_input_rejected', {
    result: 'rejected',
    ctx: { errors },
  });
  throw new AppError(40001, { errors });
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
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const imgBase = deps.config.IMG_BASE_URL;

  app.get('/api/v1/admin/products', guard, (req, res, next) => {
    void (async () => {
      try {
        const q = req.query as { status?: unknown; page?: unknown; size?: unknown };
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
        if (status !== undefined && !(PRODUCT_STATUS as readonly string[]).includes(status)) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        const { items, total } = await repo.listAdminProducts({
          page,
          size,
          status: status as 'active' | 'offline' | undefined,
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
        if (!r.ok) rejectInvalid(deps.logger, r.errors);
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
          status: 'active',
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
        if (!r.ok) rejectInvalid(deps.logger, r.errors);
        // ── 乐观锁凭据（ADM3-02 / AJ-258，契约 0.6.18）───────────────────────────
        // ⚠️ 必须在 `validateProductInput` **之后**单独取：它不属于 `ProductInput`
        //    （商品字段与"你看到的是哪一版"是两件事，混进同一个 schema 会让
        //     "改一个字段"与"改的哪一版"在日志里说不清）。
        // @why 缺了就 40001 而不是"退化成无锁更新"：无锁 = 静默覆盖他人改价，
        //      那正是本条要堵的洞；宁可让不带凭据的旧前端**响亮失败**，
        //      也不要它继续"能用"——能用但会丢别人的改动，比不能用危险得多。
        const expected = expectedUpdatedAtOf(req.body);
        const result = await repo.updateProduct(id, {
          expectedUpdatedAt: expected,
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
            ctx: { product_id: id, expected, action: 'none（未写入）' },
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
        if (typeof status !== 'string' || !(PRODUCT_STATUS as readonly string[]).includes(status)) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        const hit = await repo.setProductStatus(id, status as 'active' | 'offline');
        if (!hit) throw new AppError(40401, { product_id: id });
        res.json({ id, status });
      } catch (e) {
        next(e);
      }
    })();
  });
}
