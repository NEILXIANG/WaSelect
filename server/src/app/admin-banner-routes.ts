/**
 * 职责：管理端 Banner 端点（I2 U-D3）——`GET/POST /admin/banners`、
 *      `PUT/DELETE /admin/banners/{id}`。
 *
 * @why 四条路由共用**一个** `requireRole` 守卫实例（与商品/订单/运营配置管理端同口径）：
 *      守卫抄四遍，"将来要不要加一条审计"就得改四处，漏一处就是
 *      "某条管理端接口没守卫"——而这种漏法不会报错，只会静默地裸露。
 *
 * @why `POST` **必须返回带 `id` 的 Banner**（契约给了 `Banner` 响应体，与 `PUT` 不同）：
 *      前端 `banners/api.ts` 的形状断言**硬失败**在缺 `id` 上，
 *      而它用这个 id 去打后续的 `PUT /admin/banners/{id}`——
 *      缺 id 的表现是"保存成功，然后一点编辑就打到 /undefined"（与订单主键 `order_id` 同类教训）。
 *      `PUT` 则相反：契约只给 200、前端不读，所以**空体**（ADR-28：无消费方的字段是死数据）。
 *
 * @why `image`（完整 URL）由服务端用 `IMG_BASE_URL` 拼，不存进表里：
 *      表里存的是 `image_key`（AJ-143 的定论）。把完整 URL 存进业务表，
 *      换域名/换图床时要改历史数据；反过来让前端从 URL 反解 key，
 *      是靠字符串巧合工作，规则一变就静默产出错 key 且无人报错。
 *      ⚠️ 这是 `IMG_BASE_URL` 的**第一个消费方**（此前配置项存在但没人用）。
 *
 * @limitation 一：`IMG_BASE_URL` **未配置时不带 `image` 字段**（而不是给空串）：
 *      空串会被前端当成"有一张图、图裂了"；字段缺席才是"没有可展示的 URL"。
 *      与浏览降级同口径（汇率缺币就少显示一个展示价，不显示 0）。
 * @limitation 二：`DELETE` **幂等**——不存在的 id 也返回 204（AJ-152）。
 *      管理端的 id 恒来自列表，"id 写错"这条路径不存在，而"双击删两次"是真实会发生的。
 *      代价：删一个已被别人删掉的 banner 也不会有提示。
 * @limitation 三：`starts_at` / `ends_at` 不参与列表过滤（仓储 @why）：
 *      "当前该展示哪些"是买家侧 `/home` 的判定（I2 后续），管理端只给全量。
 *      两处各判一次会漂移。
 *
 * @see adapters/banners-admin.ts（仓储）；domain/banner-input.ts（校验，与前端同一套规则）；
 *      contracts/api-contract.yaml（Banner / BannerInput）
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
import { createBannersAdminRepo, type BannerRow } from '../adapters/banners-admin.js';
import { parseBannerInput } from '../domain/banner-input.js';

export interface AdminBannerRoutesDeps {
  db: Db;
  logger: Logger;
  config: AppConfig;
  idGen: IdGen;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/**
 * 仓储行 → 契约 `Banner`。
 * @returns 不带 `image` 的情况见文件头 @limitation 一
 */
function toBanner(r: BannerRow, imgBaseUrl: string | undefined): Record<string, unknown> {
  const at = (d: Date | null): string | undefined => (d === null ? undefined : d.toISOString());
  return {
    id: r.id,
    image_key: r.image_key,
    link_type: r.link_type,
    ...(r.link_id !== null ? { link_id: r.link_id } : {}),
    sort: r.sort,
    active: r.active,
    ...(at(r.starts_at) === undefined ? {} : { starts_at: at(r.starts_at) as string }),
    ...(at(r.ends_at) === undefined ? {} : { ends_at: at(r.ends_at) as string }),
    // 尾部斜杠只在拼接处处理一次：库里存的是 key，不是 URL
    ...(imgBaseUrl === undefined
      ? {}
      : { image: `${imgBaseUrl.replace(/\/+$/, '')}/${r.image_key}` }),
  };
}

/** 校验失败 → 40001，字段明细写日志（与 admin-product-routes 同口径）。 */
function rejectInvalid(logger: Logger, e: unknown): never {
  logger.warn('admin_banner_input_rejected', {
    result: 'rejected',
    ctx: { reason: (e as { details?: unknown }).details },
  });
  throw e;
}

export function mountAdminBannerRoutes(app: Express, deps: AdminBannerRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const repo = createBannersAdminRepo(deps.db);

  app.get('/api/v1/admin/banners', guard, (_req, res, next) => {
    void (async () => {
      try {
        const rows = await repo.listBanners();
        res.json(rows.map((r) => toBanner(r, deps.config.IMG_BASE_URL)));
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/banners', guard, (req, res, next) => {
    void (async () => {
      try {
        let input;
        try {
          input = parseBannerInput(req.body);
        } catch (e) {
          rejectInvalid(deps.logger, e);
        }
        const row = await repo.insertBanner({
          id: deps.idGen.uuid(),
          imageKey: input.imageKey,
          linkType: input.linkType,
          linkId: input.linkId,
          sort: input.sort,
          active: input.active,
          startsAtMs: input.startsAtMs,
          endsAtMs: input.endsAtMs,
        });
        res.status(201).json(toBanner(row, deps.config.IMG_BASE_URL));
      } catch (e) {
        next(e);
      }
    })();
  });

  app.put('/api/v1/admin/banners/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        let input;
        try {
          input = parseBannerInput(req.body);
        } catch (e) {
          rejectInvalid(deps.logger, e);
        }
        const row = await repo.updateBanner(id, {
          imageKey: input.imageKey,
          linkType: input.linkType,
          linkId: input.linkId,
          sort: input.sort,
          active: input.active,
          startsAtMs: input.startsAtMs,
          endsAtMs: input.endsAtMs,
        });
        // 🈲 不能当"改成功了"：那是静默失败（文件头 @why）
        if (row === null) throw new AppError(40402, { banner_id: id });
        res.status(200).end();
      } catch (e) {
        next(e);
      }
    })();
  });

  app.delete('/api/v1/admin/banners/:id', guard, (req, res, next) => {
    void (async () => {
      try {
        await repo.deleteBanner(String(req.params.id));
        // 幂等：0 行命中也 204（@limitation 二）
        res.status(204).end();
      } catch (e) {
        next(e);
      }
    })();
  });
}
