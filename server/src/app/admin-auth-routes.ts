/**
 * 职责：`POST /api/v1/auth/admin/login`——管理端邮箱密码登录（D-38 ⑤；O-11 / AJ-181 / AJ-187）。
 *       签 aud=admin、12 小时的 JWT（auth.ts DEFAULT_TTL_SEC），ver = users.token_ver（改密/封禁即时失效，D25）。
 *
 * @why 两层防爆破，各管一类：① **IP 限流**（RATE_LIMIT_LOGIN_PER_15MIN，挂在路由前，D-52）挡同一出口的连发；
 *      ② **账号锁定**（连续失败 ADMIN_LOGIN_MAX_FAILURES 次锁 ADMIN_LOGIN_LOCK_MINUTES 分钟）
 *      挡"换 IP 慢慢试同一个账号"。只有①时住宅代理池能无限试；只有②时单 IP 能把所有管理员挨个锁死。
 * @why 锁定的键是 **`sha256(lower(email))` 而不是账号 id**（AJ-187）：用 id 时"这个邮箱不存在"
 *      就无处计数、也永不锁定，于是"第 6 次是 429 还是 401"能问出这个邮箱有没有注册过——
 *      登录口就成了管理员邮箱探测器。按邮箱哈希计数后，**有没有这个人都是同一把锁**。
 * @why **先扣额度、再比对**（A1 的修法）：`claimLoginAttempt` 在 bcrypt **之前**执行，
 *      是一条带"未锁定"条件的原子语句，**0 行命中 = 已锁 → 直接 42901，连 bcrypt 都不跑**。
 *      旧实现是"先读锁 → 再花 ~100ms 比对 → 最后才计数"，并发 N 个请求会全部读到"未锁"、
 *      全部走完比对——账号维度的"最多试 5 次"并没有被真正封顶（文件头曾声称封顶，与事实不符）。
 *      现在额度是**硬**的：第 6 个并发请求拿不到额度，也就拿不到比对结果。
 * @why 不存在的邮箱也做一次 bcrypt 比对（DUMMY_HASH）：否则"找不到人时省掉 ~100ms"
 *      会变成可测的时间差，登录口又成了邮箱探测器（与上面按邮箱哈希计数是同一件事的两面）。
 * @why 锁住时**先于**口令校验拒绝（42901，与 IP 限流同码）：锁住期间放口令校验进来，
 *      攻击者仍能用"429 还是 401"区分口令对错——锁就只剩计数意义。
 * @why 口令对了才判 is_admin / blocked（40301）：顺序反过来，"这个邮箱是不是管理员"不用猜口令就能问出来。
 * @tradeoff 锁定会被人利用来**故意锁住**真管理员（知道邮箱就能连错 5 次）。接受：锁只有 15 分钟、
 *      IP 限流让单个攻击源每 15 分钟只能锁一次，而换来的是口令爆破在账号维度被封顶。
 * @limitation 日志只记 target_user_id（找得到人时）与结果，**不记邮箱**（约束七脱敏红线）；
 *      找不到人的失败因此无法按"哪个邮箱"检索——排查靠 IP 与时间。
 *
 * @see adapters/admin-auth.ts（库侧）；app/auth.ts（signToken / verifyPassword / 预哈希）；
 *      contracts/api-contract.yaml /auth/admin/login；migrations/015_login_attempts.sql；D-38 ⑤ / D-52
 */
import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import {
  claimLoginAttempt,
  clearLoginAttempt,
  findAdminCredential,
  loginAttemptKey,
} from '../adapters/admin-auth.js';
import { signToken, verifyPassword, type AuthConfig } from './auth.js';

/** 连续失败多少次锁定（D-38 ⑤：5 次）。 */
export const ADMIN_LOGIN_MAX_FAILURES = 5;
/** 锁多久（分钟，D-38 ⑤：15 分钟）。 */
export const ADMIN_LOGIN_LOCK_MINUTES = 15;

/**
 * 找不到账号时拿来比对的哈希（让"没有这个人"也付一次 bcrypt 的时间）。
 * @measured(node -e bcryptjs.hashSync, 2026-09-29)：cost 10 一次约 100ms 量级——不比对就是可测的时间差。
 * 值本身无意义（任何口令都比不上），只要是合法的 bcrypt 串、成本与真哈希同档。
 */
const DUMMY_HASH = '$2b$10$v0B4o0iWhgKRl/BcEw7snObpnEcHc3rKZuiTQ6KW7PN1Efy62ZZ1S';

/** 契约：email 必填、password minLength 12（N11）；上限挡超长输入（DoS 面，auth.ts PASSWORD_MAX_CHARS 同口径）。 */
const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[^\s@]+@[^\s@]+$/),
  password: z.string().min(12).max(1024),
});

export interface AdminAuthRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  authConfig: AuthConfig;
  /** IP 限流中间件（装配处按 rateLimitRules.adminLogin 生成后传入）。 */
  loginLimiter: RequestHandler;
}

export function mountAdminAuthRoutes(app: Express, deps: AdminAuthRoutesDeps): void {
  app.post('/api/v1/auth/admin/login', deps.loginLimiter, (req, res, next) => {
    void (async () => {
      try {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) throw new AppError(40001, { reason: 'admin_login_shape' });
        const { email, password } = parsed.data;
        const now = deps.clock.now();
        const keyHash = loginAttemptKey(email);

        // ① 先扣额度（原子）。已锁 → 拿不到额度 → 直接 42901，且不跑 bcrypt。
        const claim = await claimLoginAttempt(deps.db, keyHash, now, {
          maxFailures: ADMIN_LOGIN_MAX_FAILURES,
          lockMinutes: ADMIN_LOGIN_LOCK_MINUTES,
        });
        if (claim.kind === 'locked') {
          const retrySec = Math.max(
            1,
            Math.ceil((claim.lockedUntil.getTime() - now.getTime()) / 1000),
          );
          res.setHeader('retry-after', String(retrySec));
          const cred = await findAdminCredential(deps.db, email);
          deps.logger.warn('admin_login_locked', {
            result: 'rejected',
            ...(cred !== null ? { target_user_id: cred.id } : {}),
            ctx: { retry_after_sec: retrySec, known_account: cred !== null },
          });
          throw new AppError(42901, { reason: 'admin_account_locked' });
        }

        const cred = await findAdminCredential(deps.db, email);
        const ok = await verifyPassword(password, cred?.passwordHash ?? DUMMY_HASH);
        if (cred === null || cred.passwordHash === null || !ok) {
          deps.logger.warn('admin_login_failed', {
            result: 'rejected',
            ...(cred !== null ? { target_user_id: cred.id } : {}),
            ctx: { known_account: cred !== null, locked: claim.lockedUntil !== null },
          });
          throw new AppError(40101, { reason: 'admin_login_bad_credentials' });
        }

        // ② 口令对了清额度。仍带"未锁定"条件：返回 locked 说明比对期间被并发请求上了锁，
        //    此时不能发 token（否则"并发里夹一个对的"就能绕过锁）。
        const cleared = await clearLoginAttempt(deps.db, keyHash, now);
        if (cleared === 'locked') {
          deps.logger.warn('admin_login_locked', {
            result: 'rejected',
            target_user_id: cred.id,
            ctx: { reason: 'locked_while_verifying' },
          });
          throw new AppError(42901, { reason: 'admin_account_locked' });
        }

        if (!cred.isAdmin || cred.blocked) {
          deps.logger.warn('admin_login_forbidden', {
            result: 'rejected',
            target_user_id: cred.id,
            ctx: { is_admin: cred.isAdmin, blocked: cred.blocked },
          });
          throw new AppError(40301, { reason: 'admin_login_not_admin_or_blocked' });
        }

        const token = await signToken(
          { sub: cred.id, role: 'admin', ver: cred.tokenVer },
          deps.authConfig,
        );
        deps.logger.info('admin_login_ok', { result: 'ok', target_user_id: cred.id });
        res.json({ token });
      } catch (e) {
        next(e);
      }
    })();
  });
}
