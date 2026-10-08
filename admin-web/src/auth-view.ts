/**
 * 职责：登录与会话相关的**视图纯函数**（登录错误文案、密码长度预检、JWT 过期提醒）。
 *
 * @why 界面一律叫「密码」「手机验证码」（AJ-410 / N5、N2）：标签写密码、报错写口令，新手会以为是两样东西；
 *      「二次验证码」对新手是黑话，它其实是手机验证器 App 上的 6 位数字。
 *
 * @why 从 LoginForm / App 抽出：文案分支与"什么时候提醒快过期"都是可测的纯逻辑，
 *      留在组件里只能靠真机点（第三轮缺口 P1-7 / P2-43）。
 *
 * @see ./LoginForm.tsx；./App.tsx；packages/shared/src/limits.ts（ADMIN_PASSWORD_MIN_LENGTH）
 */
import {
  ADMIN_LOGIN_LOCK_MINUTES,
  ADMIN_LOGIN_MAX_FAILURES,
  ADMIN_PASSWORD_MIN_LENGTH,
} from '@waselect/shared';
import { ApiError } from './api/errors.js';

/**
 * 登录提交前的本地预检；通过返回 ''。**按表单自上而下的顺序**报错。
 *
 * @why 邮箱必须进预检：修订前只查口令与二次验证码（签名里根本没有 email），
 *      空表单点「登录」时页面**零反馈**——唯一的提示是 `<input required>` 的浏览器原生气泡，
 *      它随焦点离开即消失，且样式不受控（2026-10-08 实机复现）。
 * @why 顺序=表单顺序（邮箱→口令→验证码）：管理员看见的第一条就是他最先要改的那一行，
 *      而不是先被告知"口令太短"、改完再撞下一次。
 * @limitation 邮箱只查**形状**（非空、有 @、域名里有 .），不做 RFC 5322 全量校验：
 *      权威判定在服务端（形状 + 账号是否存在）；这里漏放行的最坏后果是多打一次请求，
 *      而把服务端才懂的规则抄一份到前端，两处必然漂移。
 */
export function loginPrecheck(email: string, password: string, totp = ''): string {
  const mail = email.trim();
  if (mail === '') return '请填写邮箱';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return '邮箱格式不正确（形如 name@example.com）';
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH)
    return `密码至少 ${ADMIN_PASSWORD_MIN_LENGTH} 位`;
  // P1-5：二次验证码可留空（账号没开 TOTP）；填了就得是 6 位数字——形状不对服务端回 40001，先在这里拦
  if (totp !== '' && !/^\d{6}$/.test(totp))
    return '手机验证码是 6 位数字（手机验证器 App 上显示的那串）';
  return '';
}

/** 登录失败的三段展示：红字原因、（可选）提醒、报障码（单独一行小灰字，AJ-410 / N5）。 */
export interface LoginErrorView {
  text: string;
  /** 输错时的锁定提醒（N6）；'' = 不提醒。 */
  hint: string;
  /** 报障码；'' = 没有。 */
  traceId: string;
}

/**
 * 登录失败 → 给管理员看的文案。
 * @why 40101 在登录接口上的含义是"邮箱或密码不对"，而不是通用注册表里的"未登录或登录已过期"——
 *      照搬后者，管理员会以为是会话问题去清缓存（P2-43）。
 * @why 42901 读 `retry-after`（秒）换算成分钟（向上取整）；头读不到时只说"稍后再试"，不编数字。
 * @why 报障码不再拼进红字（AJ-410 / N5）：由调用方用 `TraceLine` 单独一行显示。
 * @why 输错时提醒"连续输错会锁定"（N6），数字来自 shared 常量（与服务端同一个）；
 *      只说**规则**，不说"还剩几次"——后者会给暴力破解者计数（LoginForm @limitation 二）。
 */
export function loginErrorText(err: unknown): LoginErrorView {
  if (!(err instanceof ApiError)) return { text: '登录失败，请稍后重试', hint: '', traceId: '' };
  const traceId = err.traceId;
  // 开了手机验证的账号：密码对、码错也是同一个 40101（服务端刻意不区分，不泄露"密码是对的"）
  if (err.code === 40101) {
    return {
      text: '邮箱、密码或手机验证码不正确',
      hint: `请看清再输：连续输错 ${ADMIN_LOGIN_MAX_FAILURES} 次会暂时锁定 ${ADMIN_LOGIN_LOCK_MINUTES} 分钟`,
      traceId,
    };
  }
  if (err.code === 42901) {
    const sec = err.retryAfterSec;
    const text =
      sec !== undefined
        ? `输错次数太多，已暂时锁定，请约 ${Math.max(1, Math.ceil(sec / 60))} 分钟后再试`
        : '输错次数太多，已暂时锁定，请稍后再试';
    return { text, hint: '', traceId };
  }
  return { text: err.message, hint: '', traceId };
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
