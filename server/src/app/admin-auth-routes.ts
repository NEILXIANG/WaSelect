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
 * @tradeoff 锁定会被人利用来**故意锁住**真管理员（知道邮箱就能连错 5 次），换来的是口令爆破在账号维度被封顶。
 *      ⚠️ 这里曾写"IP 限流让单个攻击源每 15 分钟只能锁一次"来说明代价可接受——算错了（AJ-241）：
 *      IP 限流是 5 次 / 15 分钟，锁是"5 次尝试 → 锁 15 分钟"，两个周期相同，
 *      所以**一个 IP 就能让某个邮箱持续处于锁定**（每 15 分钟补 5 次）。
 *      现在（AJ-243）额度分两层：**来源桶**（邮箱 × 来源 IP，5 次）+ **邮箱桶**（30 次），
 *      单个来源只能锁住它自己；要锁死所有人得凑够 6 个来源。改密（`npm run admin:password`）一次清掉两层。
 *      ⚠️ "6 个来源"这个论证在两种现实条件下**曾经是错的**（OPS3-04 / PAY3-01，2026-09-30 已修）：
 *      ① 邮箱桶是**累计**计数（没有时间窗），一个来源每 15 分钟 5 次、约 90 分钟就能攒到 30；
 *      ② IPv6 下凑来源**不要钱**——来源按 /64 归一，而一台持有 /56 的主机就有 256 个 /64。
 *      现在两处都补上：计数带 15 分钟窗口（超时从这一轮重新起算），登录来源对 IPv6 归到 `/56`。
 *      ⚠️ 但**没有一道是上限**：持有 /48 的来源仍有 256 个 /56 可用，慢速攻击只是被抬高成本。
 *      真正的封顶在**边缘**：部署时管理端 API 放到 Cloudflare Access 之后（D-81③），
 *      并**必须同时**配 `ORIGIN_VERIFY_SECRET`——Access 只拦经 CF 的流量，
 *      源站 `.onrender.com` 是公网可达的，不配源站校验时直连源站就绕过了 Access。
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
  loginAttemptSourceKey,
} from '../adapters/admin-auth.js';
import { signToken, verifyPassword, type AuthConfig } from './auth.js';
import { ipKeyForLogin } from './rate-limit.js';

/** 同一邮箱、**同一来源**连续失败多少次锁定该来源（D-38 ⑤：5 次；AJ-243 起按来源计）。 */
export const ADMIN_LOGIN_MAX_FAILURES = 5;
/**
 * 同一邮箱、**不分来源**合计失败多少次锁定全部来源（AJ-243）。
 * @why 来源桶让单个 IP 只能锁住自己，但也让"换 IP 慢慢试"不再有总上限；这一层把总数封顶。
 *      取 30：攻击者要凑够 6 个来源才能把所有人锁住（原来 1 个就够）；
 *      对口令爆破是 30 次 / 15 分钟 ≈ 每天 2,880 次，对 ≥12 位口令可忽略。
 */
export const ADMIN_LOGIN_GLOBAL_MAX_FAILURES = 30;
/** 锁多久（分钟，D-38 ⑤：15 分钟）。 */
export const ADMIN_LOGIN_LOCK_MINUTES = 15;
/**
 * 计数窗口（分钟，OPS3-04）：早于"现在 − 窗口"的失败**不再计入** `failed_count`。
 *
 * @why 没有它时 `failed_count` 是累计值，只在"达到上限置锁"与"登录成功"时归零，
 *      于是路由头注释里那句"30 次 / 15 分钟"是假的——实际是"累计 30 次，不分多久"。
 *      AJ-243 的论证（"单个 IP 只能锁住它自己；要锁死所有人得凑够 6 个来源"）因此在慢速攻击下不成立。
 * @why 与 `ADMIN_LOGIN_LOCK_MINUTES` 同长（15）：语义就是"15 分钟内 N 次"，
 *      与注释原本承诺的一致。分成两个常量而不是复用一个，是为了将来两层各自校准时不改语义。
 */
export const ADMIN_LOGIN_WINDOW_MINUTES = 15;

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
        const globalKey = loginAttemptKey(email);
        // 来源 = trust proxy 取到的 req.ip，再过 `ipKeyForLogin`（IPv6 归 `/56`，比 IP 限流的 /64 更粗）。
        // @why 不用 ipKey（PAY3-01）：来源桶要防的是"凑够 N 个来源去耗光邮箱桶"，
        //      而 IPv6 下凑来源不要钱——一台 /56 的主机就有 256 个 /64。
        const sourceKey = loginAttemptSourceKey(email, ipKeyForLogin(req.ip ?? 'unknown'));
        // ⚠️ 带窗口（OPS3-04）：`failed_count` 原来是**累计**的，"30 次 / 15 分钟"这句承诺是假的——
        //    慢速攻击（每 15 分钟 5 次）约 90 分钟就能把邮箱桶攒满，锁住所有来源。
        const policy = (maxFailures: number) => ({
          maxFailures,
          lockMinutes: ADMIN_LOGIN_LOCK_MINUTES,
          windowMinutes: ADMIN_LOGIN_WINDOW_MINUTES,
        });

        // ① 先扣额度（原子），两层都要拿到：来源桶（5）+ 邮箱桶（30）。
        //    任一已锁 → 42901，且不跑 bcrypt。来源桶在前：攻击者被锁在自己的来源上时，
        //    不再消耗邮箱桶——否则他照样能把全局那 30 次耗光。
        const bySource = await claimLoginAttempt(
          deps.db,
          sourceKey,
          now,
          policy(ADMIN_LOGIN_MAX_FAILURES),
          globalKey,
        );
        const byEmail =
          bySource.kind === 'locked'
            ? bySource
            : await claimLoginAttempt(
                deps.db,
                globalKey,
                now,
                policy(ADMIN_LOGIN_GLOBAL_MAX_FAILURES),
              );
        if (bySource.kind === 'locked' || byEmail.kind === 'locked') {
          const until = (bySource.kind === 'locked' ? bySource : byEmail).lockedUntil ?? now;
          const retrySec = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
          res.setHeader('retry-after', String(retrySec));
          const cred = await findAdminCredential(deps.db, email);
          deps.logger.warn('admin_login_locked', {
            result: 'rejected',
            ...(cred !== null ? { target_user_id: cred.id } : {}),
            ctx: {
              retry_after_sec: retrySec,
              known_account: cred !== null,
              scope: bySource.kind === 'locked' ? 'source' : 'email',
            },
          });
          throw new AppError(42901, { reason: 'admin_account_locked' });
        }

        const cred = await findAdminCredential(deps.db, email);
        const ok = await verifyPassword(password, cred?.passwordHash ?? DUMMY_HASH);
        if (cred === null || cred.passwordHash === null || !ok) {
          deps.logger.warn('admin_login_failed', {
            result: 'rejected',
            ...(cred !== null ? { target_user_id: cred.id } : {}),
            ctx: {
              known_account: cred !== null,
              locked: bySource.lockedUntil !== null || byEmail.lockedUntil !== null,
            },
          });
          throw new AppError(40101, { reason: 'admin_login_bad_credentials' });
        }

        // ② 口令对了清额度。仍带"未锁定"条件：返回 locked 说明比对期间被**别的**并发请求上了锁，
        //    此时不能发 token（否则"并发里夹一个对的"就能绕过锁）。
        //    ⚠️ 自己这次 claim 置上的锁（最后一次额度）要能清掉——把它传进去（R-02 / AJ-224）；
        //    不传的话"错 4 次、第 5 次输对"会被自己锁 15 分钟。
        const clearedSource = await clearLoginAttempt(
          deps.db,
          sourceKey,
          now,
          bySource.lockedUntil,
        );
        const clearedEmail = await clearLoginAttempt(deps.db, globalKey, now, byEmail.lockedUntil);
        if (clearedSource === 'locked' || clearedEmail === 'locked') {
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
