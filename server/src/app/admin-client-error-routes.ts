/**
 * 职责：`POST /api/v1/admin/client-errors`——管理端前端报错上报（AJ-421，契约 0.6.57）。
 *       校验 → 记一条 error 级运行日志 `admin_client_error` → 204。
 *
 * @why 落**运行日志**（流 A），不落 `user_events`（流 C，/beacon）：报错是技术排障信息，不是用户行为；
 *      混进行为表会污染漏斗统计，也把自由文本（错误消息、调用栈）带进一张只收白名单字段的表（约束七）。
 * @why 记 error 级就够了，不另接 Sentry：服务端 Sentry 挂在日志输出流上（adapters/sentry.ts），
 *      error 行自动上报，且上报的是已经过 `redact()` 的那一行——消息里的邮箱 / 电话由同一处脱敏。
 *      浏览器不引 Sentry SDK（CLAUDE.md：第三方交付物默认不引入）。
 * @why `skipAudit`：上报不是管理员对业务数据的操作，进了 admin_audit 会让运营日志页满屏"前端报错"。
 * @why 只收管理员：这不是公开入口，买家 / 匿名打进来会把它变成任意写日志的口子。
 * @limitation 一：服务端不限频——前端每次页面加载最多报 10 条并去重（admin-web/src/ui/error-report.ts）；
 *              管理员令牌被盗用来刷日志属于更大的事故，不在这里防。Sentry 分流自带每分钟上限（默认 30）。
 * @limitation 二：调用栈在日志里按单字段 512 字符截断（带截断标记，redact.ts LOG_STRING_CAP），
 *              生产构建的栈是压缩后的行列号，要对着 source map 才读得懂（构建暂不上传 source map）。
 * @see domain/client-error-input.ts；admin-web/src/ui/ErrorBoundary.tsx
 */
import type { Express } from 'express';
import type { IdentityCheck } from '../adapters/identity.js';
import { parseClientError } from '../domain/client-error-input.js';
import type { Logger } from '../logger.js';
import { skipAudit } from './admin-audit.js';
import { requireRole, type AuthConfig } from './auth.js';

export interface AdminClientErrorRoutesDeps {
  logger: Logger;
  auth: AuthConfig;
  identity: IdentityCheck;
}

export function mountAdminClientErrorRoutes(app: Express, deps: AdminClientErrorRoutesDeps): void {
  app.post(
    '/api/v1/admin/client-errors',
    requireRole('admin', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      try {
        const e = parseClientError(req.body);
        skipAudit(res);
        deps.logger.error('admin_client_error', {
          result: 'reported',
          ctx: { kind: e.kind, page: e.page, message: e.message, stack: e.stack },
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );
}
