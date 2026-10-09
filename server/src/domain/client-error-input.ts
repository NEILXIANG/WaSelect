/**
 * 职责：管理端前端报错上报（`POST /admin/client-errors`，AJ-421）的输入校验。纯函数，不查库、不取时钟。
 *
 * @why 只收三种来源（render = 错误边界接住的渲染异常；error = window error；rejection = 未处理的 Promise 拒绝），
 *      不收任意 kind：日志按 kind 聚合，开放取值会让一个前端 bug 把检索面打散。
 * @why page 只认小写段名（与 admin-web 路由页名同形）：它会进日志检索维度，自由文本会把 URL / 查询参数
 *      （可能带订单号、客户 id）一起带进来。
 * @why 超长**拒绝**而不是截断：截断由前端做（它知道哪一段最有用）；服务端再截一次，日志里看到的
 *      "完整消息"其实是被截过的——与 redact.ts 截断标记的 @why 同一个理由。
 * @limitation 只校验形状；内容里的个人信息由日志统一脱敏（redact → maskText）兜底，这里不再扫一遍。
 * @see app/admin-client-error-routes.ts；admin-web/src/ui/error-report.ts
 */
import { AppError } from '../errors.js';

export const CLIENT_ERROR_KINDS = ['render', 'error', 'rejection'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** 错误消息上限（字符）。 */
export const CLIENT_ERROR_MESSAGE_MAX = 500;
/** 调用栈上限（字符）。日志单字段另有 512 字符的截断（redact.ts LOG_STRING_CAP），超出部分带截断标记。 */
export const CLIENT_ERROR_STACK_MAX = 2000;

const PAGE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface ClientErrorInput {
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  page: string | null;
}

const bad = (reason: string): AppError => new AppError(40001, { reason });

export function parseClientError(body: unknown): ClientErrorInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body_shape');
  const b = body as Record<string, unknown>;
  const kind = b['kind'];
  if (typeof kind !== 'string' || !(CLIENT_ERROR_KINDS as readonly string[]).includes(kind)) {
    throw bad('kind_invalid');
  }
  const message = typeof b['message'] === 'string' ? b['message'].trim() : '';
  if (message === '') throw bad('message_required');
  if (message.length > CLIENT_ERROR_MESSAGE_MAX) throw bad('message_too_long');
  const rawStack = b['stack'];
  if (rawStack !== undefined && rawStack !== null && typeof rawStack !== 'string') {
    throw bad('stack_invalid');
  }
  const stack = typeof rawStack === 'string' && rawStack !== '' ? rawStack : null;
  if (stack !== null && stack.length > CLIENT_ERROR_STACK_MAX) throw bad('stack_too_long');
  const rawPage = b['page'];
  if (rawPage !== undefined && rawPage !== null) {
    if (typeof rawPage !== 'string' || !PAGE_RE.test(rawPage)) throw bad('page_invalid');
  }
  return {
    kind: kind as ClientErrorKind,
    message,
    stack,
    page: typeof rawPage === 'string' ? rawPage : null,
  };
}
