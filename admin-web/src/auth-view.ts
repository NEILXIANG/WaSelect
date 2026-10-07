/**
 * 职责：登录与会话相关的**视图纯函数**（登录错误文案、口令长度预检、JWT 过期提醒）。
 *
 * @why 从 LoginForm / App 抽出：文案分支与"什么时候提醒快过期"都是可测的纯逻辑，
 *      留在组件里只能靠真机点（第三轮缺口 P1-7 / P2-43）。
 *
 * @see ./LoginForm.tsx；./App.tsx；packages/shared/src/limits.ts（ADMIN_PASSWORD_MIN_LENGTH）
 */
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import { ApiError } from './api/errors.js';

/**
 * 登录提交前的本地预检；通过返回 ''。
 * @why 服务端对短于 12 位的口令直接拒（契约 minLength），前端先拦，省一次请求、
 *      也不让"口令太短"消耗登录失败计数。只查长度，不做强度规则（强度以服务端为准）。
 */
export function loginPrecheck(password: string): string {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH)
    return `口令至少 ${ADMIN_PASSWORD_MIN_LENGTH} 位`;
  return '';
}

/**
 * 登录失败 → 给管理员看的文案（带报障码）。
 * @why 40101 在登录接口上的含义是"邮箱或口令不对"，而不是通用注册表里的"未登录或登录已过期"——
 *      照搬后者，管理员会以为是会话问题去清缓存（P2-43）。
 * @why 42901 读 `retry-after`（秒）换算成分钟（向上取整）；头读不到时只说"稍后再试"，不编数字。
 */
export function loginErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return '登录失败，请稍后重试';
  const tail = err.traceId !== '' ? `（报障码：${err.traceId}）` : '';
  if (err.code === 40101) return `邮箱或口令不正确${tail}`;
  if (err.code === 42901) {
    const sec = err.retryAfterSec;
    return sec !== undefined
      ? `尝试过多，请约 ${Math.max(1, Math.ceil(sec / 60))} 分钟后再试${tail}`
      : `尝试过多，请稍后再试${tail}`;
  }
  return `${err.message}${tail}`;
}

/**
 * 读 JWT 的 `exp`（秒级 Unix 时间）；**不校验签名**，只为提前提醒。读不出返回 null。
 * @why 管理员 token 12h 过期；表单填到一半突然 40101 是 P1-7 的根源之一。提前 10 分钟提醒，
 *      让他有机会先保存。读不出（非 JWT / 损坏）就不提醒——不猜。
 * @limitation 解码的是客户端自己拿着的 payload：被篡改也只影响提醒时机，不影响鉴权（鉴权在服务端）。
 */
export function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** 提前多久提醒（毫秒）。 */
export const EXPIRY_WARN_MS = 10 * 60 * 1000;

/**
 * 会话剩余时间提示：距过期 ≤ 10 分钟时给提醒文案，其余返回 ''。
 * @param expMs `jwtExpMs` 的结果；`nowMs` 由调用方给（纯函数不读时钟）。
 */
export function expiryWarning(expMs: number | null, nowMs: number): string {
  if (expMs === null) return '';
  const left = expMs - nowMs;
  if (left > EXPIRY_WARN_MS) return '';
  if (left <= 0) return '登录已过期：下一次操作会要求重新登录（已填的内容不会丢）';
  return `登录将在约 ${Math.ceil(left / 60000)} 分钟后过期：请尽快保存手上的修改`;
}
