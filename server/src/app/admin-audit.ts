/**
 * 职责：管理端写接口的**操作审计中间件**（流 B，ADR-29；F-02 / AJ-183）——挂在 `/api/v1/admin` 前缀上，
 *       对每一次**成功的**管理端写操作（POST / PUT / PATCH / DELETE → 2xx）往 `admin_audit` 追加一行。
 *
 * @why 一个入口覆盖全部管理端写接口（而不是每条路由各写一行 insert）：
 *      ① 新增一条管理端写路由**自动**被审计，不靠"记得去写"——漏写审计不会报任何错，只会在出事那天查不到；
 *      ② 审计的形状（actor / action / target / 脱敏）只有一份实现，不会在第二份里漂移。
 * @why 在响应 `finish` 之后写、只写 2xx：此时业务事务已提交，"有审计行"⇔"改动真的发生了"；
 *      4xx / 5xx 不写（没有发生的改动不该出现在审计里；失败原因在运行日志里）。
 * @why action 用**路由模板**（`PATCH /admin/products/:id/status`）而不是实际路径：按动作检索
 *      （"谁改过价"）不必做字符串模式匹配；具体对象在 target。
 * @why after = 请求体（脱敏后）：它就是管理员"要把它改成什么"。before 只有路由**显式**提供时才有
 *      （setAuditBefore）：取改前值要额外读库，只对**不可逆**的操作做（运费整表替换、汇率追加）。
 * @tradeoff 审计写入**不与业务同事务**：极少数情况下（库在两次写之间断开）会出现"改了但没审计"，
 *      这时打 error 级 `admin_audit_write_failed`（带 action / target）让它可见。换来的是零侵入：
 *      不需要改任何一条路由的事务边界。反过来的错误（审计了但没改）不会发生（只写 2xx）。
 * @limitation 一：登录（/auth/admin/login）不在 /admin 前缀下，不进本表——登录成败在运行日志（admin_login_*）。
 * @limitation 二：multipart 上传的请求体不是 JSON，after 记为 null（上传结果的 key 在运行日志里）。
 * @limitation 三：脱敏是**键名黑名单**（PII_KEYS）：新增含 PII 的字段名必须补进来，否则会原样落库。
 *
 * @see ports/admin-audit.ts；adapters/admin-audit.ts；migrations/002_hardening.sql（表 + append-only 触发器）
 */
import type { RequestHandler, Response } from 'express';
import type { Logger } from '../logger.js';
import type { AdminAuditStore } from '../ports/admin-audit.js';
import { currentContext } from '../context.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** 落库前替换成 `[redacted]` 的键名（约束七的 PII 清单：地址、电话、邮箱、口令）。 */
export const PII_KEYS = new Set([
  'password',
  'phone',
  'email',
  'contact_email',
  'recipient',
  'line1',
  'line2',
]);
const AUDIT_BEFORE_KEY = 'adminAuditBefore';

/** 路由提供"改前值"（只对不可逆操作用，见文件头 @why）。 */
export function setAuditBefore(res: Response, before: unknown): void {
  res.locals[AUDIT_BEFORE_KEY] = before;
}

/** 请求体 → 审计 after：递归按键名脱敏；非对象 / 非数组 → null。 */
export function auditPayload(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((v) => redact(v));
  if (body === null || typeof body !== 'object') return null;
  return redact(body);
}

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = PII_KEYS.has(k) ? '[redacted]' : redact(x);
  }
  return out;
}

export function adminAuditMiddleware(deps: {
  store: AdminAuditStore;
  logger: Logger;
}): RequestHandler {
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) {
      next();
      return;
    }
    // 上下文在进入时取（finish 回调不保证还在同一条异步链上）
    const { trace_id: traceId, req_id: reqId } = currentContext();
    res.on('finish', () => {
      const principal = req.auth;
      const routePath = (req.route as { path?: unknown } | undefined)?.path;
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (principal?.role !== 'admin' || typeof routePath !== 'string') return;
      const id = req.params['id'];
      const entry = {
        actor: `admin:${principal.sub}`,
        action: `${req.method} ${routePath.replace(/^\/api\/v1/, '')}`,
        target: typeof id === 'string' ? id : null,
        before: res.locals[AUDIT_BEFORE_KEY],
        after: auditPayload(req.body),
        traceId: traceId ?? null,
        reqId: reqId ?? null,
      };
      deps.store.append(entry).catch((e: unknown) => {
        deps.logger.error('admin_audit_write_failed', {
          result: 'failed',
          err: e,
          ctx: { action: entry.action, target: entry.target },
        });
      });
    });
    next();
  };
}
