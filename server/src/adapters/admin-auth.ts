/**
 * 职责：管理员登录的**库侧**动作——读凭据、记失败（含锁定）、清失败、初始管理员 seed（O-11 / AJ-181）。
 *
 * @why 与 `identity.ts`（每个受保护请求的身份回源）分开：那条是热路径、带 60 秒缓存；
 *      这里是登录时的冷路径，要读口令哈希与锁定列——把它们塞进热路径的查询会让每个请求多搬一段哈希。
 * @why 锁定判定写在**一条 UPDATE** 里（库内原子读改写）：两次并发失败若由应用层"读 4 写 5"，
 *      会各自写 5 而漏锁；PG 的行锁让同一行的两条 UPDATE 串行执行，第二条读到的是第一条的结果。
 *      @measured(app/admin-auth-store.db.test.ts「并发」用例, 2026-09-29)：5 次并发失败 → 恰好 1 次返回锁定时刻。
 * @limitation 一：邮箱匹配按 `lower(email)`（迁移 003 的函数唯一索引 users_email_lower_key 保证唯一且走索引）。
 * @limitation 二：seed 只建号不改号——已有同邮箱账号（大小写不敏感）一律不动（见 ensureInitialAdmin 的 @why）。
 *
 * @see migrations/014_admin_login_lockout.sql；app/admin-auth-routes.ts；技术文档 v0.5 §5（aud=admin 12h）；D-38 ⑤
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

/** 登录要用到的账号信息（**含口令哈希**：只在登录路由里流转，绝不进日志或响应）。 */
export interface AdminCredential {
  id: string;
  isAdmin: boolean;
  blocked: boolean;
  passwordHash: string | null;
  tokenVer: number;
  failures: number;
  lockedUntil: Date | null;
}

export async function findAdminCredential(db: Db, email: string): Promise<AdminCredential | null> {
  const rows = await db<
    {
      id: string;
      is_admin: boolean;
      blocked_at: Date | null;
      password_hash: string | null;
      token_ver: number;
      failed_login_count: number;
      login_locked_until: Date | null;
    }[]
  >`
    select id, is_admin, blocked_at, password_hash, token_ver, failed_login_count, login_locked_until
      from users where lower(email) = lower(${email})
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    isAdmin: r.is_admin,
    blocked: r.blocked_at !== null,
    passwordHash: r.password_hash,
    tokenVer: r.token_ver,
    failures: r.failed_login_count,
    lockedUntil: r.login_locked_until,
  };
}

/**
 * 记一次失败；达到 maxFailures 时锁到 `now + lockMinutes` 并把计数归零（下一轮从 0 数）。
 * @returns 本次触发锁定 → 锁到的时刻；否则 null。
 * @why 锁定时计数归零而不是继续累加：锁到期后给一个完整的新窗口（再错 max 次才再锁），
 *      而不是"到期后错一次就又锁"——后者对记错口令的真管理员过于严厉，对攻击者也没有多挡一次。
 */
export async function recordLoginFailure(
  db: Db,
  userId: string,
  now: Date,
  policy: { maxFailures: number; lockMinutes: number },
): Promise<Date | null> {
  const rows = await db<{ locked: Date | null }[]>`
    update users set
      failed_login_count = case when failed_login_count + 1 >= ${policy.maxFailures}
                                then 0 else failed_login_count + 1 end,
      login_locked_until = case when failed_login_count + 1 >= ${policy.maxFailures}
                                then ${now}::timestamptz + make_interval(mins => ${policy.lockMinutes})
                                else login_locked_until end
     where id = ${userId}
    returning case when failed_login_count = 0 and login_locked_until is not null
                    and login_locked_until > ${now}::timestamptz
                   then login_locked_until end as locked
  `;
  return rows[0]?.locked ?? null;
}

/** 登录成功：失败计数与锁一起清。 */
export async function recordLoginSuccess(db: Db, userId: string): Promise<void> {
  await db`
    update users set failed_login_count = 0, login_locked_until = null where id = ${userId}
  `;
}

/**
 * 初始管理员 seed（D-38 ⑤：ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD，启动时执行，幂等）。
 * @param passwordHash 调用方用 `hashPassword` 算好的哈希（预哈希 + bcrypt，与登录校验同一套）
 * @returns 'created' 新建了 | 'exists' 已有同邮箱账号（**不动它**）
 * @why 不覆盖已存在账号的口令：env 里的初始口令常年不删，每次部署都覆盖 = 管理员改过的口令被悄悄重置回初始值；
 *      也不把已存在的普通账号"提升"为管理员——提权必须是人做的、留痕的动作，不能由一个 env 变量顺手完成。
 * @why `insert … select … where not exists` 一条语句：两个实例同时启动时，函数唯一索引兜住竞态
 *      （后到的那条 23505），这里按"已存在"处理。
 */
export async function ensureInitialAdmin(
  db: Db,
  email: string,
  passwordHash: string,
): Promise<'created' | 'exists'> {
  try {
    const rows = await db`
      insert into users (id, email, password_hash, is_admin)
      select ${`adm-${randomUUID()}`}, ${email}, ${passwordHash}, true
       where not exists (select 1 from users where lower(email) = lower(${email}))
      returning id
    `;
    return rows.length > 0 ? 'created' : 'exists';
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return 'exists';
    throw e;
  }
}
