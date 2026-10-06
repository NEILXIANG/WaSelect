/**
 * 职责：`adapters/admin-auth.ts`（放在 app/ 下：要用 app/auth.ts 的口令哈希，而 adapters 不得反向依赖 app；
 *      管理员凭据读取 / 登录额度与锁定 / 初始管理员 seed）真库用例（AJ-181 / AJ-187）。
 *
 * @why 锁定的**取额度**逻辑写在**一条 SQL** 里（读-改-写在库内原子完成）：
 *      应用层"先读计数再写回"在并发下会各自读到 4、各自写 5——第 6 次还能试，
 *      "最多试 5 次"就只是写在注释里的话。这里钉的是 SQL 在**并发**下的结果，不是单线程下的结果。
 * @why 键是 `sha256(lower(email))` 而不是账号 id：不存在的邮箱也要计数、也要上锁（B14），
 *      否则"第 6 次是 429 还是 401"能问出这个邮箱有没有注册过——登录口就是管理员邮箱探测器。
 * @why seed 只在"没有这个邮箱（大小写不敏感）"时建号，**绝不**改已存在账号的口令：
 *      env 里的 ADMIN_INITIAL_PASSWORD 常年不删，每次部署都覆盖一遍 = 管理员改过的口令被悄悄重置回初始值。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { hashPassword, verifyPassword } from './auth.js';
import {
  claimLoginAttempt,
  clearLoginAttempt,
  deleteStaleLoginAttempts,
  ensureInitialAdmin,
  findAdminCredential,
  loginAttemptKey,
  loginAttemptsCutoff,
} from '../adapters/admin-auth.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

const NOW = new Date('2026-09-29T02:00:00.000Z');
const POLICY = { maxFailures: 3, lockMinutes: 15 };

async function attemptRow(keyHash: string) {
  const [r] = await db`
    select failed_count, locked_until from login_attempts where key_hash = ${keyHash}`;
  return {
    failedCount: Number(r?.['failed_count'] ?? -1),
    lockedUntil: (r?.['locked_until'] as Date | null | undefined) ?? null,
  };
}

describe('admin-auth 仓储', () => {
  it('findAdminCredential：按 lower(email) 找；不存在 → null', async () => {
    await db`insert into users (id, email, password_hash, is_admin) values ('u-a', 'A@x.com', 'h', true)`;
    const c = await findAdminCredential(db, 'a@X.COM');
    expect(c).toMatchObject({ id: 'u-a', isAdmin: true, passwordHash: 'h' });
    expect(await findAdminCredential(db, 'nobody@x.com')).toBeNull();
  });

  it('claimLoginAttempt：前 max-1 次只累加不锁；第 max 次置锁且计数归零', async () => {
    const key = loginAttemptKey('a@x.com');
    for (let i = 1; i < POLICY.maxFailures; i += 1) {
      const c = await claimLoginAttempt(db, key, NOW, POLICY);
      expect(c).toEqual({ kind: 'claimed', failedCount: i, lockedUntil: null });
    }
    const locked = await claimLoginAttempt(db, key, NOW, POLICY);
    expect(locked).toEqual({
      kind: 'claimed',
      failedCount: 0,
      lockedUntil: new Date('2026-09-29T02:15:00.000Z'),
    });
    expect(await attemptRow(key)).toEqual({
      failedCount: 0,
      lockedUntil: new Date('2026-09-29T02:15:00.000Z'),
    });
  });

  it('claimLoginAttempt：锁没到期 → 拿不到额度（locked）；到期后 → 重新放行且计数从 1 起', async () => {
    const key = loginAttemptKey('a@x.com');
    await claimLoginAttempt(db, key, NOW, POLICY);
    await claimLoginAttempt(db, key, NOW, POLICY);
    expect((await claimLoginAttempt(db, key, NOW, POLICY)).kind).toBe('claimed'); // 第 3 次触发锁

    const during = await claimLoginAttempt(db, key, new Date('2026-09-29T02:10:00.000Z'), POLICY);
    expect(during).toEqual({ kind: 'locked', lockedUntil: new Date('2026-09-29T02:15:00.000Z') });
    // 锁住期间**一次额度都没扣**：计数与锁定时刻都不该被这次请求改动
    expect(await attemptRow(key)).toEqual({
      failedCount: 0,
      lockedUntil: new Date('2026-09-29T02:15:00.000Z'),
    });

    const after = await claimLoginAttempt(db, key, new Date('2026-09-29T02:16:00.000Z'), POLICY);
    expect(after).toEqual({ kind: 'claimed', failedCount: 1, lockedUntil: null });
  });

  /**
   * OPS3-04：`failed_count` 原来是**累计**的（只在置锁与登录成功时归零），
   * 于是"30 次 / 15 分钟"这句承诺是假的——实际是"累计 30 次，不分多久"。
   * 后果：一个来源每 15 分钟试 5 次（恰好也在 IP 限流之内），约 90 分钟就把邮箱桶攒到 30，
   * 锁住**所有来源**（含管理员的办公网络）15 分钟；计数归零后继续攒。
   */
  it('🔴 计数有窗口：慢速失败（每 16 分钟 2 次，max=3）永远攒不到锁', async () => {
    const key = loginAttemptKey('slow@x.com');
    const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000);
    // 第 1 轮：0 / 1 分钟各一次 → count=2
    expect((await claimLoginAttempt(db, key, at(0), POLICY)).kind).toBe('claimed');
    expect((await claimLoginAttempt(db, key, at(1), POLICY)).kind).toBe('claimed');
    expect((await attemptRow(key)).failedCount).toBe(2);

    // 第 2 轮（16 分钟之后）：窗口已过 → 从 1 重新起算，不是 3（否则这一下就锁了）
    const later = await claimLoginAttempt(db, key, at(16), POLICY);
    expect(later).toEqual({ kind: 'claimed', failedCount: 1, lockedUntil: null });
    expect((await attemptRow(key)).failedCount).toBe(1);

    // 再过 16 分钟：同样从 1 起算——慢速攻击永远攒不满
    expect((await claimLoginAttempt(db, key, at(17), POLICY)).kind).toBe('claimed');
    const again = await claimLoginAttempt(db, key, at(32), POLICY);
    expect(again).toEqual({ kind: 'claimed', failedCount: 1, lockedUntil: null });
  });

  it('窗口**内**的连续失败照旧会锁（加了窗口不是让锁失效）', async () => {
    const key = loginAttemptKey('burst@x.com');
    // 同在 NOW 这一刻连错 3 次（max=3）：窗口没过，第 3 次照常置锁
    await claimLoginAttempt(db, key, NOW, POLICY);
    await claimLoginAttempt(db, key, NOW, POLICY);
    expect((await claimLoginAttempt(db, key, NOW, POLICY)).kind).toBe('claimed');
    expect((await attemptRow(key)).lockedUntil).not.toBeNull();
    expect((await claimLoginAttempt(db, key, NOW, POLICY)).kind).toBe('locked');
  });

  it('窗口与锁时长可以不同（windowMinutes 显式给出时按它算）', async () => {
    const key = loginAttemptKey('w2@x.com');
    const p = { maxFailures: 100, lockMinutes: 15, windowMinutes: 10 };
    await claimLoginAttempt(db, key, NOW, p);
    await claimLoginAttempt(db, key, NOW, p);
    expect((await attemptRow(key)).failedCount).toBe(2);
    // 12 分钟 > 10 分钟窗口 → 归 1；但 < 15 分钟锁时长（若已锁则根本走不到这里）
    const after = await claimLoginAttempt(db, key, new Date(NOW.getTime() + 12 * 60_000), p);
    expect(after).toEqual({ kind: 'claimed', failedCount: 1, lockedUntil: null });
  });

  /**
   * A1 的核心：**额度是硬的**。旧实现先读锁再比对，30 个并发请求会全部读到"未锁"。
   */
  it('claimLoginAttempt 并发 30 次（max=5）：恰好 5 次拿到额度，其余 25 次全 locked', async () => {
    const key = loginAttemptKey('a@x.com');
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        claimLoginAttempt(db, key, NOW, { maxFailures: 5, lockMinutes: 15 }),
      ),
    );
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(5);
    expect(results.filter((r) => r.kind === 'locked')).toHaveLength(25);
    // 拿到额度的那 5 次里恰好有一次触发了锁定（第 5 次），不多不少
    const row = await attemptRow(key);
    expect(row.failedCount).toBe(0);
    expect(row.lockedUntil?.toISOString()).toBe('2026-09-29T02:15:00.000Z');
  });

  it('B14：账号不存在的邮箱与真实账号**同一把锁**，键之间互不干扰', async () => {
    const ghost = loginAttemptKey('ghost@example.com');
    const real = loginAttemptKey('real@example.com');
    // 两条键各自数到 max，互不加成：否则"试 A 邮箱"会锁住 B 的登录
    expect((await claimLoginAttempt(db, ghost, NOW, POLICY)).kind).toBe('claimed');
    expect((await claimLoginAttempt(db, real, NOW, POLICY)).kind).toBe('claimed');
    expect((await attemptRow(ghost)).failedCount).toBe(1);
    expect((await attemptRow(real)).failedCount).toBe(1);

    // 不存在的邮箱连错 max 次后同样拿不到额度——"429 还是 401"不再能区分邮箱是否注册过
    await claimLoginAttempt(db, ghost, NOW, POLICY);
    await claimLoginAttempt(db, ghost, NOW, POLICY);
    expect((await claimLoginAttempt(db, ghost, NOW, POLICY)).kind).toBe('locked');
    expect((await claimLoginAttempt(db, real, NOW, POLICY)).kind).toBe('claimed');
  });

  it('clearLoginAttempt：三态分清——cleared / absent（从没失败过）/ locked（比对期间被锁）', async () => {
    const key = loginAttemptKey('a@x.com');
    expect(await clearLoginAttempt(db, key, NOW)).toBe('absent');

    await claimLoginAttempt(db, key, NOW, POLICY);
    expect(await clearLoginAttempt(db, key, NOW)).toBe('cleared');
    // clear 只清零不删行（行留着无害，删了反而让"从没失败过"与"清过"无法区分）
    expect(await attemptRow(key)).toEqual({ failedCount: 0, lockedUntil: null });

    // 锁生效后再清 → 清不动（这是"并发里夹一个正确口令也绕不过锁"的落点）
    await claimLoginAttempt(db, key, NOW, POLICY);
    await claimLoginAttempt(db, key, NOW, POLICY);
    await claimLoginAttempt(db, key, NOW, POLICY);
    expect(await clearLoginAttempt(db, key, NOW)).toBe('locked');
  });

  /**
   * R-02 / AJ-224：上一条钉的是"**别人**上的锁清不动"；这一条钉"**自己**那次 claim 上的锁清得动"。
   * @why 两条必须同时成立：只有前一条 ⇒ 第 max 次输对也被锁（回归）；只有后一条 ⇒ 任何人都能清锁（A1 复活）。
   */
  it('clearLoginAttempt：触发锁定的那次 claim 拿自己的 lockedUntil 能清；拿别的时刻清不动', async () => {
    const key = loginAttemptKey('own-lock@example.com');
    let last = await claimLoginAttempt(db, key, NOW, POLICY);
    for (let i = 1; i < POLICY.maxFailures; i += 1) {
      last = await claimLoginAttempt(db, key, NOW, POLICY);
    }
    if (last.kind !== 'claimed' || last.lockedUntil === null) {
      throw new Error('前置不成立：第 max 次 claim 应返回 claimed 且带上它置的锁');
    }
    // 拿一个"差 1 毫秒"的时刻冒充 → 清不动（相等才算自己的锁）
    const forged = new Date(last.lockedUntil.getTime() - 1);
    expect(await clearLoginAttempt(db, key, NOW, forged)).toBe('locked');
    // 不是触发者（手里是 null）→ 清不动
    expect(await clearLoginAttempt(db, key, NOW, null)).toBe('locked');
    // 触发者本人 → 清掉，行回到全新状态
    expect(await clearLoginAttempt(db, key, NOW, last.lockedUntil)).toBe('cleared');
    expect(await attemptRow(key)).toEqual({ failedCount: 0, lockedUntil: null });
  });

  it('deleteStaleLoginAttempts：过期且已解锁的删；还在锁里的留（锁是生效中的安全状态）', async () => {
    const stale = loginAttemptKey('stale@example.com');
    const hot = loginAttemptKey('hot@example.com');
    const longAgo = new Date('2026-09-28T00:00:00.000Z');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${stale}, 2, null, ${longAgo}, ${longAgo}),
             (${hot}, 0, ${new Date('2026-09-30T02:00:00.000Z')}, ${longAgo}, ${longAgo})`;
    // 基准 = 2026-09-29T03:00 往前 24h = 2026-09-28T03:00：两行的 last_failed_at 都更早，
    // 差别只在 locked_until——这条用例要钉的就是"还在锁里的不删"
    const cutoff = loginAttemptsCutoff(new Date('2026-09-29T03:00:00.000Z'));
    expect(await deleteStaleLoginAttempts(db, cutoff)).toBe(1);
    const left = await db`select key_hash from login_attempts order by key_hash`;
    expect(left.map((r) => r.key_hash)).toEqual([hot]);
  });

  it('ensureInitialAdmin：无此邮箱 → 建管理员（口令可校验）；已有（大小写不同也算）→ 不动口令', async () => {
    const hash = await hashPassword('initial-password-123');
    expect(await ensureInitialAdmin(db, 'Boss@Example.com', hash)).toBe('created');
    const [u] =
      await db`select id, is_admin, password_hash from users where lower(email) = 'boss@example.com'`;
    expect(u?.['is_admin']).toBe(true);
    expect(await verifyPassword('initial-password-123', String(u?.['password_hash']))).toBe(true);

    const other = await hashPassword('another-password-456');
    expect(await ensureInitialAdmin(db, 'boss@example.com', other)).toBe('exists');
    const [after] = await db`select password_hash from users where id = ${String(u?.['id'])}`;
    expect(after?.['password_hash']).toBe(u?.['password_hash']);
    expect(await db`select 1 from users`).toHaveLength(1);
  });

  it('🔴 ADMIN_EMAIL 带首尾空白（控制台粘贴常见）→ 建出的账号能用干净邮箱登录（S-07）', async () => {
    const hash = await hashPassword('initial-password-123');
    expect(await ensureInitialAdmin(db, '  Ops@Example.com \n', hash)).toBe('created');
    expect(await findAdminCredential(db, 'ops@example.com')).not.toBeNull();
  });
});
