/**
 * 职责：管理员登录的**库侧**动作——读凭据、登录额度（失败计数与锁定）、初始管理员 seed（O-11 / AJ-181 / AJ-187）。
 *
 * @why 与 `identity.ts`（每个受保护请求的身份回源）分开：那条是热路径、带 60 秒缓存；
 *      这里是登录时的冷路径，要读口令哈希——把它塞进热路径的查询会让每个请求多搬一段哈希。
 *
 * @why **计数与锁落的键是 `sha256(lower(email))`，不是 users.id**（AJ-187 重写，替代 014 的两列）：
 *      ① 锁必须挡在 bcrypt **之前**才真的封顶（旧实现先读锁、再花 ~100ms 比对、最后才计数，
 *         并发 N 个请求会全部读到"未锁"、全部走完比对——"最多试 5 次"形同虚设）；
 *      ② 不存在的邮箱在 users 里没有行，用 id 就无处计数，于是"第 6 次是 429 还是 401"
 *         能问出这个邮箱是不是已注册账号（登录口当邮箱探测器用）。
 *      键按邮箱哈希后两者都解决：**有没有这个人都按同一个键计数、同一把锁**。
 *      ⚠️ **AJ-243 之后这里是两层桶**，上面这句只对**邮箱桶**成立：
 *      来源桶的键是 `sha256(lower(email) + '|' + 来源)`（`loginAttemptSourceKey`），
 *      即"同一个邮箱在不同来源上各有一把 5 次的额度"。文件头曾经只写邮箱桶那一层，
 *      照它读会以为改密清一层就够（PAY3-06）。
 * @why 扣额度是一条 `insert … on conflict do update … where 未锁定` 的原子语句：
 *      应用层"先读计数再写回"在并发下会各自读到 4、各自写 5（第 6 次还能试）；
 *      PG 对冲突行加行锁让同键的两条语句串行执行，第二条读到的是第一条的结果，
 *      而 `where` 让已锁的行**不返回行**——"0 行"就是"已锁"的唯一判据，不需要先读再判。
 * @limitation 一：邮箱匹配按 `lower(email)`（迁移 003 的函数唯一索引 users_email_lower_key 保证唯一且走索引）。
 * @limitation 二：seed 只建号不改号——已有同邮箱账号（大小写不敏感）一律不动（见 ensureInitialAdmin 的 @why）。
 * @limitation 三：`login_attempts` 只增不删，靠 daily 作业清过期行（app/login-attempts-cleanup.ts），
 *      清理窗口 {@link LOGIN_ATTEMPT_RETENTION_HOURS}。它不负责清理，只提供删除函数。
 *
 * @see migrations/015_login_attempts.sql（014 的两列已在此退役）；app/admin-auth-routes.ts；
 *      app/login-attempts-cleanup.ts；技术文档 v0.5 §5（aud=admin 12h）；D-38 ⑤
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

/** 登录要用到的账号信息（**含口令哈希**：只在登录路由里流转，绝不进日志或响应）。 */
export interface AdminCredential {
  id: string;
  isAdmin: boolean;
  blocked: boolean;
  passwordHash: string | null;
  tokenVer: number;
}

/**
 * 邮箱的**唯一归一结果**（SEC2-07 / AJ-335）：`trim` 之后按 JS 的 `toLowerCase()`。
 *
 * @why 额度键（本文件、JS 侧）与查人（`findAdminCredential`、PG 的 `lower()`）**必须用同一份结果**，
 *      否则"能查到这个人"与"记到哪个桶"会分叉。分叉的真实形态（实测 en_US.UTF-8）：
 *      · JS `'İ'.toLowerCase()` = `i` + U+0307 组合点（2 个码位）；
 *      · PG `lower('İ')` = `i`（1 个码位，ascii 105）。
 *      于是 `admİn@example.com` 经 PG 的 `lower()` **查得到** `admin@example.com` 这个人，
 *      而它的额度键是 JS 归一的结果 ⇒ **另一个桶**。邮箱里每有一个 `i` 就多一倍桶，
 *      AJ-243 那句"总尝试数由邮箱桶 30 次封顶"因此可以被绕过。
 * @why 归一放在 **JS 侧**、查人改成 `where lower(email) = ${norm}`（不再对入参调 PG 的 `lower`）：
 *      这样"查得到这个人"⇔"JS 归一结果 == PG 对库里那一列的 lower 结果"，
 *      而后者只取决于库里存的值 ⇒ **凡是能查到这个人的输入，必然落进同一个桶**。
 *      反过来（继续让 PG 归一入参）就永远存在两个归一函数，迟早还有第二个 `İ`。
 * @limitation 若库里存的邮箱本身含非 ASCII 大写（例如 seed 进去的 `ADMİN@…`），
 *      PG 的 `lower()` 会把它折成 `admin@…`，而 JS 归一对任何输入都保留组合点 ⇒ **永远查不到**。
 *      现实里 `ADMIN_EMAIL` 是运维填的 ASCII 串，且唯一索引也是 PG 的 `lower()`；
 *      真出现这种账号的表现是"这个邮箱登录不了"，而不是安全洞——已在此登记。
 */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 登录额度键：`sha256(normalizeAdminEmail(email))` 的 hex。
 * @why 不存邮箱明文：这张表会为**根本不存在的邮箱**建行（B14 要求它们也要计数也要锁），
 *      存明文等于把"谁被探测过"落成一张表（约束七脱敏红线）。
 * @why 无盐确定性哈希：必须能"同一个邮箱每次算出同一个键"才能查得到；
 *      @tradeoff 因此挡不住"拿到库后枚举候选邮箱比对哈希"，但保护了更现实的那一种泄露
 *      （库被拖走后不直接给出邮箱清单）。加盐就查不到键了，不可行。
 */
export function loginAttemptKey(email: string): string {
  return createHash('sha256').update(normalizeAdminEmail(email), 'utf8').digest('hex');
}

/**
 * 登录额度的**来源桶**键：`sha256(normalizeAdminEmail(email) + "\n" + 来源)` 的 hex（AJ-243）。
 * @param source 已归一的来源（调用方传 `ipKeyForLogin(req.ip)`：IPv4 原样、IPv6 归到 /56）
 * @why 只按邮箱计时，**一个** IP 就能让某个邮箱持续锁定（IP 限流与账号锁的周期相同）；
 *      把来源混进键里，攻击者的失败只锁住攻击者自己那个来源。
 *      总尝试数的上限由邮箱桶（`loginAttemptKey`）另外兜着。
 * @why 分隔符用换行：邮箱里不可能出现换行（路由的形状校验拒绝空白），拼接不会有歧义。
 */
export function loginAttemptSourceKey(email: string, source: string): string {
  return createHash('sha256')
    .update(`${normalizeAdminEmail(email)}\n${source}`, 'utf8')
    .digest('hex');
}

/** 过期登录尝试的保留窗口（小时）：早于此刻且**已解锁**的行由 daily 作业清掉。 */
export const LOGIN_ATTEMPT_RETENTION_HOURS = 24;

export interface LoginAttemptPolicy {
  maxFailures: number;
  lockMinutes: number;
  /**
   * OPS3-04：计数窗口（分钟）；不给 = 与 `lockMinutes` 同长。
   *
   * @why 没有窗口时 `failed_count` 是**累计**的：只在"达到上限置锁"与"登录成功"时才归零。
   *      于是"30 次 / 15 分钟"这句承诺是假的——它其实是"累计 30 次，不分多久"。
   *      AJ-243 的论证（"单个 IP 只能锁住它自己；要锁死所有人得凑够 6 个来源"）因此在慢速攻击下不成立：
   *      一个来源每 15 分钟试 5 次（恰好也在 IP 限流 5/15min 之内），约 90 分钟就把邮箱桶攒到 30，
   *      锁住**所有来源**（含管理员的办公网络）15 分钟；计数归零后继续攒。
   *      持续效果是"每约 90 分钟锁住管理员 15 分钟"——SEC2-01 只是被稀释，没有消除。
   * @why 窗口取 `lockMinutes` 同长：语义就是"15 分钟内 N 次"，与路由头注释原本承诺的一致；
   *      做成独立字段是为了让两层（来源 5 次 / 邮箱 30 次）将来可以各自校准而不改语义。
   */
  windowMinutes?: number | undefined;
}

/**
 * 扣一次登录尝试额度的结果（判别联合）。
 * @why 用判别联合而不是 `{ locked: boolean; until: Date | null }`：后者允许
 *      `{ locked: true, until: null }` 这种自相矛盾的形状，调用方每次都要判断到底信哪个字段。
 */
export type LoginAttemptClaim =
  | { kind: 'locked'; lockedUntil: Date }
  | { kind: 'claimed'; failedCount: number; lockedUntil: Date | null };

/** 清零的结果：`absent`（这个键从没失败过，无需清）与 `locked`（清不动）必须分开。 */
export type ClearLoginAttemptResult = 'cleared' | 'absent' | 'locked';

export async function findAdminCredential(db: Db, email: string): Promise<AdminCredential | null> {
  const rows = await db<
    {
      id: string;
      is_admin: boolean;
      blocked_at: Date | null;
      password_hash: string | null;
      token_ver: number;
    }[]
  >`
    -- ⚠️ 右边必须是 JS 归一的结果（normalizeAdminEmail），不能让 PG 再归一一次：
    --    PG 的 lower() 与 JS 的 toLowerCase() 不是同一个函数（'İ' 上实测不同，见该函数 @why）。
    --    两边各归一一次 ⇒ "查得到这个人"与"记到哪个桶"会分叉，邮箱桶的 30 次上限可被绕过（SEC2-07）。
    select id, is_admin, blocked_at, password_hash, token_ver
      from users where lower(email) = ${normalizeAdminEmail(email)}
  `;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    isAdmin: r.is_admin,
    blocked: r.blocked_at !== null,
    passwordHash: r.password_hash,
    tokenVer: r.token_ver,
  };
}

/**
 * **在口令比对之前**扣掉一次尝试额度；已锁定则不给额度（调用方据此直接 42901，不碰 bcrypt）。
 *
 * @why 时机是这里的全部意义：额度扣在 bcrypt 之前，"最多试 max 次"才是**硬封顶**；
 *      扣在之后（旧实现）时，N 个并发请求都先读到"未锁"，于是全都跑完 100ms 的 bcrypt，
 *      锁只在事后才生效——封顶的是"失败次数"而不是"能尝试的次数"。
 * @why 达到 maxFailures 时**计数归零并置锁**（而不是继续累加）：锁到期后给一个完整的新窗口
 *      （再错 max 次才再锁），而不是"到期后错一次就又锁"——后者对记错口令的真管理员过于严厉，
 *      对攻击者也没有多挡一次。
 * @why `where` 里的"未锁定"条件让已锁的行**不返回行**：0 行即已锁，不需要先 SELECT 再判
 *      （先读后判正是旧实现被并发越过的根因）。
 * @returns `kind:'locked'` 时**没有**扣额度（这一行没被改动）；`kind:'claimed'` 时已扣。
 * @limitation 触发锁定的那一次**仍会返回 claimed**（这一次的口令照样要比对）——
 *             否则"第 5 次输对了"也会被拒，那对真管理员是不可接受的；
 *             锁定由下一次请求撞到 0 行来体现。
 *             ⚠️ 这一次返回的 `lockedUntil` **非 null**（= 它自己刚置上的锁）：调用方比对通过后
 *             必须把它原样传给 {@link clearLoginAttempt} 的 `ownLockUntil`，否则清不动自己上的锁（AJ-224）。
 */
export async function claimLoginAttempt(
  db: Db,
  keyHash: string,
  now: Date,
  policy: LoginAttemptPolicy,
  /** 该行属于哪个邮箱桶（来源桶填邮箱桶的键；邮箱桶自己不填）——供改密时一次清掉（AJ-243）。 */
  scopeHash: string | null = null,
): Promise<LoginAttemptClaim> {
  // OPS3-04：窗口过期 → 从这一次**重新起算**（计数归 1、窗口起点挪到现在）。
  // ⚠️ 计算放在 JS 侧而不是在 SQL 里再写一遍 make_interval：窗口起点的比较只有一处，
  //    两处各写一份迟早漂移（约束九）。
  const windowStart = new Date(
    now.getTime() - (policy.windowMinutes ?? policy.lockMinutes) * 60_000,
  );
  const rows = await db<{ failed_count: number; locked_until: Date | null }[]>`
    insert into login_attempts as la
      (key_hash, failed_count, locked_until, first_failed_at, last_failed_at, scope_hash)
    values (${keyHash}, 1,
            case when 1 >= ${policy.maxFailures}
                 then ${now}::timestamptz + make_interval(mins => ${policy.lockMinutes}) end,
            ${now}::timestamptz, ${now}::timestamptz, ${scopeHash})
    on conflict (key_hash) do update set
      failed_count = case
                       -- 窗口过期：之前那些失败**已经作废**，这一次是新一轮的第 1 次
                       when la.first_failed_at <= ${windowStart}::timestamptz then 1
                       when la.failed_count + 1 >= ${policy.maxFailures} then 0
                       else la.failed_count + 1
                     end,
      first_failed_at = case
                          when la.first_failed_at <= ${windowStart}::timestamptz
                            then ${now}::timestamptz
                          else la.first_failed_at
                        end,
      locked_until = case
                       -- 新窗口：旧锁若已过期则一并清掉（能走到这里说明行未锁或锁已到期）
                       when la.first_failed_at <= ${windowStart}::timestamptz
                         then case when 1 >= ${policy.maxFailures}
                              then ${now}::timestamptz + make_interval(mins => ${policy.lockMinutes}) end
                       when la.failed_count + 1 >= ${policy.maxFailures}
                         then ${now}::timestamptz + make_interval(mins => ${policy.lockMinutes})
                       -- 上一轮锁已到期：放行时顺手把它清掉，别留着一个"过期但看着像还在锁"的时刻。
                       -- @measured(admin-auth-store.db.test.ts「锁没到期…」用例, 2026-09-29)：
                       --   不清的话行会变成 failed_count=1 且 locked_until=过去时刻，
                       --   查库的人/清理作业都会把它读成"锁着"，而它其实已经放行。
                       when la.locked_until is not null and la.locked_until <= ${now}::timestamptz
                         then null
                       else la.locked_until
                     end,
      last_failed_at = ${now}::timestamptz
     where la.locked_until is null or la.locked_until <= ${now}::timestamptz
    returning failed_count, locked_until
  `;
  const r = rows[0];
  if (r === undefined) {
    // 0 行 = 撞到了"未锁定"条件的反面（已锁、且还没到期）。回读一次是为了响应头的 retry-after。
    // ⚠️ 这里**曾经**写"此时行一定存在且锁已生效……这个值是稳定的（锁只会到期、不会延长）"——
    //    加了 `ownLockUntil`（AJ-224）之后不成立了：持有额度且口令正确的那个请求会把它自己
    //    刚置上的锁**清成 null**，改密也会把整行删掉（`clearLoginAttemptsForKey`）。
    //    所以 0 行与这次回读之间，`cur?.locked_until` **真的可能是 null**，`?? now` 不是
    //    "兜一个不可能的情况"。
    //    ⚠️ 反过来别把它说成"锁到期也走这里"——**不对**：到期留下的仍是"过去时刻"而不是 null，
    //    那一档根本不进 `??`（它照样回一个过去的时刻，retry-after 两侧都算出 1 秒，结果一样）。
    //    `?? now` 只覆盖"锁被主动清掉 / 行被删掉"这两条，别把边界说宽。
    const [cur] = await db<{ locked_until: Date | null }[]>`
      select locked_until from login_attempts where key_hash = ${keyHash}`;
    return { kind: 'locked', lockedUntil: cur?.locked_until ?? now };
  }
  return { kind: 'claimed', failedCount: r.failed_count, lockedUntil: r.locked_until };
}

/**
 * **只读**地看某个桶此刻是否仍在锁定期（PAY3-04）。
 *
 * @returns 仍在锁中 → 锁定时刻；未锁 / 锁已到期 / 根本没有这一行 → null
 *
 * @why 登录路由要在**扣来源桶之前**先知道邮箱桶是不是已经锁了：
 *      原来的顺序是"先扣来源桶，再扣邮箱桶，任一 locked 就 429"——邮箱桶已锁时，
 *      来源桶那一次**已经扣掉了**，请求却在没比对口令的情况下被拒。
 *      于是管理员在"邮箱桶被攻击者打满"的那 15 分钟里每重试一次，就往自己来源桶上记一笔；
 *      5 次之后来源桶自己也被锁上，而它的到期时刻是**第 5 次重试之后**的 15 分钟
 *      ——比邮箱桶那把锁还晚。攻击者早就停了，管理员却还要再等一轮（最长多 15 分钟）。
 *      AJ-243 只论证了反方向（"来源桶在前：攻击者被锁在自己的来源上时不再消耗邮箱桶"），
 *      这一侧当时没想到。
 * @why 只是**窥视**，不扣额度也不上锁：封顶仍然由 {@link claimLoginAttempt} 原子地保证，
 *      多这一次读不会让任何人多试一次（读之后并发置上的锁，claim 照样会撞到 0 行）。
 */
export async function peekLoginAttemptLock(
  db: Db,
  keyHash: string,
  now: Date,
): Promise<Date | null> {
  const rows = await db<{ locked_until: Date | null }[]>`
    select locked_until from login_attempts
     where key_hash = ${keyHash}
       and locked_until is not null
       and locked_until > ${now}::timestamptz
  `;
  return (rows[0]?.locked_until as Date | null | undefined) ?? null;
}

/**
 * 登录成功：把额度清零。
 * @why 带"未锁定"条件且**区分 0 行的两种原因**：`absent` 是"这个键从没失败过"（正常，直接过），
 *      `locked` 是"在我比对口令的这 100ms 里，另一个并发请求把锁打上了"（必须 42901）。
 *      不区分就会把"竞态下已锁"当成"没锁过"放行——那正是 A1 要堵的洞的另一半。
 * @why `ownLockUntil`（R-02 / AJ-224）：**本次请求自己那次 claim 置上的锁**可以被它自己清掉。
 *      最后一次额度的 claim 在同一条语句里就把 `locked_until` 置上了；不给这个例外的话，
 *      "错 4 次、第 5 次输对"的管理员会被自己这次请求锁 15 分钟——上面 `claimLoginAttempt`
 *      的 @limitation 承诺的正是"这种情况不能被拒"，而实现曾经相反。
 *      @measured(admin-auth-routes.db.test.ts「错 4 次、第 5 次输对」, 2026-09-30)：
 *        修复前 → `expected 429 to be 200`；修复后 → 200，行被清成 `{failed_count:0, locked_until:null}`。
 * @why 用"锁定时刻**相等**"识别"是不是我上的锁"，而不是再加一列 owner：
 *      锁生效期间任何 claim 都拿不到额度（0 行），所以**同一把锁只可能由一次 claim 置上**；
 *      别的请求手里的 `lockedUntil` 要么是 null（它不是触发者），要么是更早一轮的时刻（不相等）。
 *      这不放宽封顶：能走到这里的请求必然持有一次额度，额度总数仍由 claim 原子地限定。
 * @limitation 口令对了但账号不是管理员 / 已封禁（40301）时**也要清**：
 *             他证明了自己持有这个账号的口令，继续计数没有意义。
 * @limitation "我的额度是第 1–4 次、比对期间**别的**请求把锁打上了" 仍然返回 `locked`（42901）：
 *             这是 A1 修复的既定取舍，本次不动——此时放行不会让攻击者多试一次，
 *             但要区分"谁的锁"之外的第三种状态，收益只是并发突发下真管理员少等一轮。
 */
export async function clearLoginAttempt(
  db: Db,
  keyHash: string,
  now: Date,
  ownLockUntil: Date | null = null,
): Promise<ClearLoginAttemptResult> {
  const rows = await db<{ key_hash: string }[]>`
    update login_attempts set failed_count = 0, locked_until = null
     where key_hash = ${keyHash}
       and (locked_until is null
            or locked_until <= ${now}::timestamptz
            or locked_until = ${ownLockUntil}::timestamptz)
    returning key_hash
  `;
  if (rows.length > 0) return 'cleared';
  const [cur] = await db<{ locked_until: Date | null }[]>`
    select locked_until from login_attempts where key_hash = ${keyHash}`;
  return cur === undefined ? 'absent' : 'locked';
}

/** 清理基准时刻：早于它的"已解锁"行可以删（F10：基准来自注入时钟，业务侧不自己取 now）。 */
export function loginAttemptsCutoff(now: Date): Date {
  return new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_HOURS * 3_600_000);
}

/**
 * 删掉过期的登录尝试行。
 * @why 只删**已解锁**的行（`locked_until is null` 或已到期）：还在锁里的行是**正在生效的安全状态**，
 *      清掉它等于给人一条"连错 5 次再等一天就能重来"的捷径；留着它，锁的语义才完整。
 * @returns 删除行数（0 是正常的，不代表失败）。
 */
export async function deleteStaleLoginAttempts(db: Db, cutoff: Date): Promise<number> {
  const rows = await db<{ key_hash: string }[]>`
    delete from login_attempts
     where last_failed_at < ${cutoff}::timestamptz
       and (locked_until is null or locked_until < ${cutoff}::timestamptz)
    returning key_hash
  `;
  return rows.length;
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
      -- 右边同样用 **JS 归一的结果**（与 findAdminCredential 同一口径，SEC2-07）：
      -- "这个邮箱建过了没有"与"登录时记到哪个桶"必须是同一份归一，否则 seed 判重与登录判重会分叉。
      insert into users (id, email, password_hash, is_admin)
      select ${`adm-${randomUUID()}`}, ${email}, ${passwordHash}, true
       where not exists (select 1 from users where lower(email) = ${normalizeAdminEmail(email)})
      returning id
    `;
    return rows.length > 0 ? 'created' : 'exists';
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return 'exists';
    throw e;
  }
}

/**
 * 清掉某个邮箱名下的**全部**登录额度行：邮箱桶本身 + 记在它名下的所有来源桶（AJ-243）。
 * @why 管理员改密（`npm run admin:password`）要能一次解锁：来源桶的键里混了来源，单凭邮箱算不出来，
 *      所以来源桶的行上记了 `scope_hash`（＝邮箱桶的键，迁移 016）。
 * @returns 删掉的行数
 */
export async function deleteLoginAttemptsForEmail(db: Db, email: string): Promise<number> {
  const key = loginAttemptKey(email);
  const rows = await db`
    delete from login_attempts where key_hash = ${key} or scope_hash = ${key} returning key_hash`;
  return rows.length;
}
