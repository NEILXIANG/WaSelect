/**
 * 职责：后台商品分类接口（AJ-491，契约 0.6.74）——列表 / 新建 / 修改（名称、排序、启停）/ 删除。
 *
 * @why 分类原是写死的四个；用户 2026-10-11 要求后台可加分类、小程序动态识别、空分类不显示（成熟电商的做法）。
 * @why 校验失败走 40001 + `data {field, reason, count}`（与商品接口 AJ-488 同口径）：后台把原因码翻成人话标到输入框。
 *      键 / 名称重复也走 40001（reason `duplicate`）：是"填的值不行"，不是状态冲突。
 * @why 删除还有商品的分类 → 40919，不静默挪走商品：要由运营决定商品去哪；"不想让买家看到"用停用即可。
 * @limitation 键建好后不能改（PUT 里给了 key 即 40001 key_immutable）。审计由 admin-audit 中间件自动写（目标 = 键）。
 * @see adapters/categories.ts；domain/category-input.ts；migrations/039_product_categories.sql
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { setAuditTarget } from './admin-audit.js';
import {
  createCategory,
  deleteCategory,
  listAdminCategories,
  updateCategory,
} from '../adapters/categories.js';
import {
  validateCategoryCreate,
  validateCategoryPatch,
  type FieldError,
} from '../domain/category-input.js';

export interface AdminCategoryRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/** 校验失败 → 40001，第一个出错字段进 data（全部明细进日志）。 */
function reject(logger: Logger, errors: readonly FieldError[]): never {
  logger.warn('admin_category_input_rejected', { result: 'rejected', ctx: { errors } });
  const first = errors[0];
  throw new AppError(
    40001,
    { errors },
    first === undefined
      ? undefined
      : { field: first.field, reason: first.reason, count: errors.length },
  );
}

export function mountAdminCategoryRoutes(app: Express, deps: AdminCategoryRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const handle =
    (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) =>
    (
      req: import('express').Request,
      res: import('express').Response,
      next: (e?: unknown) => void,
    ) => {
      void fn(req, res).catch(next);
    };

  app.get(
    '/api/v1/admin/categories',
    guard,
    handle(async (_req, res) => {
      res.json({ items: await listAdminCategories(deps.db) });
    }),
  );

  app.post(
    '/api/v1/admin/categories',
    guard,
    handle(async (req, res) => {
      const v = validateCategoryCreate(req.body);
      if (!v.ok) reject(deps.logger, v.errors);
      const r = await createCategory(deps.db, v.value);
      if (!r.ok) reject(deps.logger, [{ field: r.field, reason: 'duplicate' }]);
      // 新建没有路径参数 ⇒ 审计行要显式记"建的是哪一类"（同 Banner，SEC-12）
      setAuditTarget(res, v.value.key);
      deps.logger.info('admin_category_created', { result: 'ok', ctx: { key: v.value.key } });
      res.status(201).json({ ...v.value, active: true });
    }),
  );

  app.put(
    '/api/v1/admin/categories/:key',
    guard,
    handle(async (req, res) => {
      const key = String(req.params.key);
      const v = validateCategoryPatch(req.body);
      if (!v.ok) reject(deps.logger, v.errors);
      const r = await updateCategory(deps.db, key, v.value);
      // 🈲 0 行命中不能回 200（静默失败，同 40402 Banner 的口径）
      if (r === null) throw new AppError(40404, { key });
      if ('ok' in r) reject(deps.logger, [{ field: r.field, reason: 'duplicate' }]);
      deps.logger.info('admin_category_updated', { result: 'ok', ctx: { key } });
      res.json(r);
    }),
  );

  app.delete(
    '/api/v1/admin/categories/:key',
    guard,
    handle(async (req, res) => {
      const key = String(req.params.key);
      const r = await deleteCategory(deps.db, key);
      if (r === 'not_found') throw new AppError(40404, { key });
      if (r === 'in_use') throw new AppError(40919, { key });
      // 对外带 field / reason：后台按它说清"先改掉那条 Banner"（三天提交复查 2026-10-12）
      if (r === 'banner_ref')
        throw new AppError(
          40919,
          { key, reason: 'banner_ref' },
          { field: 'key', reason: 'banner_ref' },
        );
      deps.logger.info('admin_category_deleted', { result: 'ok', ctx: { key } });
      res.status(204).end();
    }),
  );
}
