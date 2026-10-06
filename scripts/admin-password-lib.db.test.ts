/**
 * 职责：管理员改密（B17 / AJ-209）的真库验证——**能改、旧 token 失效、且改不到别人**。
 *
 * @why 这条路径的全部价值在"轮换"：
 *      · 只断言"hash 变了"是不够的——旧 token 若还能用 12 小时，等于没改（D25 的 token_ver）；
 *      · 只断言"改成功了"也不够——若 WHERE 漏了 `is_admin = true`，
 *        这个脚本就能给**任何**用户改密，那是客服越权的入口，而它在本机 CLI 里没人盯着。
 *      所以三条各钉一个方向：能改 / 旧 token 失效 / 改不到非管理员。
 *
 * @see scripts/admin-password-lib.ts（被测）；server/src/app/auth.ts（hashPassword / token_ver）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../test/db/test-db.js';
import { hashPassword, verifyPassword } from '../server/src/app/auth.js';
// 只收邮箱 / 目标库描述 / stdin 读口令这三个**纯函数**不碰库，在
// `admin-password-lib.unit.test.ts`（unit project）；这里只留要真库的：改密与审计落表。
import {
  auditAdminPasswordReset,
  createAdminAccount,
  setAdminPassword,
} from './admin-password-lib.js';
import { loginAttemptKey, loginAttemptSourceKey } from '../server/src/adapters/admin-auth.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  const { closeDb } = await import('../server/src/adapters/db.js');
  await closeDb(db);
});

async function seedAdmin(email: string, password: string, tokenVer = 3): Promise<string> {
  const rows = await db`
    insert into users (id, email, password_hash, is_admin, token_ver)
    values (${`adm-${email}`}, ${email}, ${await hashPassword(password)}, true, ${tokenVer})
    returning id
  `;
  return String(rows[0]?.['id']);
}

beforeEach(async () => {
  await resetTestDb(db);
});

describe('setAdminPassword（B17 / AJ-209）', () => {
  it('改密后新口令能登、旧口令不能登，且 token_ver +1（旧 token 立刻失效）', async () => {
    const id = await seedAdmin('Boss@Example.com', 'old-password-1234');
    const r = await setAdminPassword(db, {
      email: 'boss@example.com',
      password: 'new-password-5678',
    });
    expect(r).toEqual({ ok: true, userId: id, tokenVer: 4 });

    const row = (await db`select password_hash, token_ver from users where id = ${id}`)[0];
    // 邮箱大小写不敏感（与 ensureInitialAdmin 同口径）
    expect(row?.['token_ver']).toBe(4);
    await expect(verifyPassword('new-password-5678', String(row?.['password_hash']))).resolves.toBe(
      true,
    );
    await expect(verifyPassword('old-password-1234', String(row?.['password_hash']))).resolves.toBe(
      false,
    );
  });

  /**
   * AJ-241（第二轮审查 SEC2-01 / SEC2-05）：改密必须同时**解除登录锁定**。
   * @why 登录额度按邮箱计、连错 5 次锁 15 分钟，而 IP 限流恰好也是 5 次 / 15 分钟——
   *      知道管理员邮箱的人用一个 IP 就能让它**一直**锁着。此时管理员唯一的自救手段是本脚本；
   *      可改完密码额度行还在锁里，新口令照样 42901，全库没有第二条解锁路径。
   */
  it('🔴 改密成功 → 该邮箱的登录额度行被清掉（被人故意锁住时，这是唯一的解锁出口）', async () => {
    await seedAdmin('Boss@Example.com', 'old-password-1234');
    const key = loginAttemptKey('boss@example.com');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${key}, 0, now() + interval '15 minutes', now(), now())`;
    // AJ-243：记在该邮箱名下的**来源桶**也要一起清（管理员自己打错 5 次后改密，不能仍被自己那个来源锁着）
    const sourceKey = loginAttemptSourceKey('boss@example.com', '203.0.113.9');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at, scope_hash)
      values (${sourceKey}, 0, now() + interval '15 minutes', now(), now(), ${key})`;
    // 另一个邮箱的额度行不能被顺手清掉
    const other = loginAttemptKey('someone-else@example.com');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${other}, 3, null, now(), now())`;

    const r = await setAdminPassword(db, {
      email: 'BOSS@example.com',
      password: 'new-password-5678',
    });
    expect(r.ok).toBe(true);
    const rows = await db`select key_hash from login_attempts order by key_hash`;
    expect(rows.map((x) => x.key_hash)).toEqual([other]);
  });

  it('改密失败（口令太短 / 找不到管理员）→ 不动额度行（不给"没改成却解了锁"的副作用）', async () => {
    await seedAdmin('boss@example.com', 'old-password-1234');
    const key = loginAttemptKey('boss@example.com');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${key}, 0, now() + interval '15 minutes', now(), now())`;
    await setAdminPassword(db, { email: 'boss@example.com', password: 'short' });
    await setAdminPassword(db, { email: 'nobody@example.com', password: 'new-password-5678' });
    expect(await db`select 1 from login_attempts where key_hash = ${key}`).toHaveLength(1);

    // 同一个邮箱、但它**不是管理员**：改不动（admin_not_found），它的额度行也不许被清——
    // 否则"知道一个普通账号的邮箱"就能拿本脚本当免费的计数器重置
    await db`insert into users (id, email, is_admin) values ('u-staff', 'staff@example.com', false)`;
    const staffKey = loginAttemptKey('staff@example.com');
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${staffKey}, 4, null, now(), now())`;
    const r = await setAdminPassword(db, {
      email: 'staff@example.com',
      password: 'new-password-5678',
    });
    expect(r).toEqual({ ok: false, reason: 'admin_not_found' });
    expect(await db`select 1 from login_attempts where key_hash = ${staffKey}`).toHaveLength(1);
  });

  it('口令短于 12 位 → weak_password，库里**一行都没动**', async () => {
    const id = await seedAdmin('boss@example.com', 'old-password-1234');
    const before = (await db`select password_hash, token_ver from users where id = ${id}`)[0];
    const r = await setAdminPassword(db, { email: 'boss@example.com', password: 'short-1' });
    expect(r).toEqual({ ok: false, reason: 'weak_password' });
    const after = (await db`select password_hash, token_ver from users where id = ${id}`)[0];
    expect(after?.['password_hash']).toBe(before?.['password_hash']);
    expect(after?.['token_ver']).toBe(before?.['token_ver']);
  });

  /**
   * @why 这条是"越权"方向的反向用例：WHERE 里若没有 `is_admin = true`，
   *      本脚本就能给买家改密——而买家侧是微信登录（没有口令），
   *      真被改成有口令也无法登录，表现是"某个买家突然登不上"，排查方向完全错。
   */
  it('非管理员账号（is_admin=false）改不动：不是管理员就不是这条路径的对象', async () => {
    await db`
      insert into users (id, email, password_hash, is_admin, token_ver)
      values ('u-buyer', 'buyer@example.com', ${await hashPassword('buyer-password-1')}, false, 1)
    `;
    const r = await setAdminPassword(db, {
      email: 'buyer@example.com',
      password: 'new-password-5678',
    });
    expect(r).toEqual({ ok: false, reason: 'admin_not_found' });
    const row = (await db`select token_ver from users where id = 'u-buyer'`)[0];
    expect(row?.['token_ver']).toBe(1);
  });

  it('邮箱不存在 → admin_not_found（不静默成功）', async () => {
    const r = await setAdminPassword(db, {
      email: 'nobody@example.com',
      password: 'new-password-5678',
    });
    expect(r).toEqual({ ok: false, reason: 'admin_not_found' });
  });
});

/**
 * DB2-05：审计表此前只覆盖 HTTP 管理端写接口（中间件挂在 `/api/v1/admin` 前缀上），
 * 本机 CLI 改密在系统里**一行痕都不留**——事后回答不了"这个管理员的口令最近被改过吗"。
 */
describe('auditAdminPasswordReset（CLI 改密也要留痕）', () => {
  it('🔴 落一行：actor / action / target 正确，且**口令与前后值都不进审计**', async () => {
    const id = await seedAdmin('boss@example.com', 'old-password-1234');
    const r = await setAdminPassword(db, {
      email: 'boss@example.com',
      password: 'new-password-5678',
    });
    expect(r.ok).toBe(true);

    expect(await db`select 1 from admin_audit`).toHaveLength(0);
    await auditAdminPasswordReset(db, id);

    const rows = await db`select actor, action, target, before, after from admin_audit`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'cli:admin-password',
      action: 'CLI admin.password.reset',
      target: id,
    });
    // 口令绝不进审计表（append-only、无保留期）：连"前后值"字段也只能是 NULL
    expect(rows[0]?.['before']).toBeNull();
    expect(rows[0]?.['after']).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain('new-password-5678');
  });

  /**
   * @why 这一条是上面那条的反面：**审计不是改密的一部分**。
   *      CLI 里审计失败只告警、不回滚、也不把退出码改成失败（admin-password.ts:88-97）——
   *      口令已经改完了，报成"失败"会让人再跑一次。所以这里要钉住的是
   *      "审计抛错时**口令仍然是新的**"，而不是"抛了错"。
   */
  it('🔴 审计写失败会抛，但**口令已经是新的**（调用方只告警、不回滚）', async () => {
    const id = await seedAdmin('boss@example.com', 'old-password-1234');
    const r = await setAdminPassword(db, {
      email: 'boss@example.com',
      password: 'new-password-5678',
    });
    expect(r.ok).toBe(true);

    // 假 Db：只会被当成标签模板调用一次（before / after 都是 null，不会走到 db.json）
    const brokenDb = ((): never => {
      throw new Error('模拟审计写入失败');
    }) as unknown as Db;
    await expect(auditAdminPasswordReset(brokenDb, id)).rejects.toThrow('模拟审计写入失败');

    // 口令不受影响：审计是"事后补一笔"，不是"改密事务的一部分"
    const row = (await db`select password_hash, token_ver from users where id = ${id}`)[0];
    expect(row?.['token_ver']).toBe(4);
    await expect(verifyPassword('new-password-5678', String(row?.['password_hash']))).resolves.toBe(
      true,
    );
    // 失败的审计不会留下半行
    expect(await db`select 1 from admin_audit`).toHaveLength(0);
  });
});

/**
 * 剩余清单 3-1：多管理员建号（`npm run admin:create`）。
 * @why 此前只有启动时按 ADMIN_EMAIL 建**一个**初始管理员；第二个运营要登录只能改库，且无留痕。
 */
describe('createAdminAccount（3-1）', () => {
  it('🔴 新邮箱 → 建出管理员（邮箱归一、口令可验），并落一条 CLI admin.create 审计', async () => {
    const r = await createAdminAccount(db, {
      email: '  Ops2@Example.com ',
      password: 'ops2-password-1234',
    });
    expect(r.ok).toBe(true);
    const [u] =
      await db`select id, email, password_hash, is_admin from users where email = 'ops2@example.com'`;
    expect(u?.['is_admin']).toBe(true);
    await expect(verifyPassword('ops2-password-1234', String(u?.['password_hash']))).resolves.toBe(
      true,
    );
    const audit = await db`select actor, action, target, before, after from admin_audit`;
    expect(audit.map((a) => ({ ...a }))).toEqual([
      {
        actor: 'cli:admin-create',
        action: 'CLI admin.create',
        target: u?.['id'],
        before: null,
        after: null,
      },
    ]);
  });

  it('已存在同邮箱（管理员或普通账号）→ exists，不改口令、不提权、不写审计', async () => {
    await seedAdmin('boss@example.com', 'old-password-1234');
    await db`insert into users (id, email, password_hash, is_admin) values ('u-plain', 'plain@example.com', 'x', false)`;
    expect(
      await createAdminAccount(db, { email: 'BOSS@example.com', password: 'another-pass-9999' }),
    ).toEqual({
      ok: false,
      reason: 'exists',
    });
    expect(
      await createAdminAccount(db, { email: 'plain@example.com', password: 'another-pass-9999' }),
    ).toEqual({
      ok: false,
      reason: 'exists',
    });
    const [p] = await db`select is_admin from users where id = 'u-plain'`;
    expect(p?.['is_admin']).toBe(false);
    expect(await db`select 1 from admin_audit`).toHaveLength(0);
  });

  it('口令短于下限 → weak_password，库里不多一行', async () => {
    expect(await createAdminAccount(db, { email: 'x@example.com', password: 'short' })).toEqual({
      ok: false,
      reason: 'weak_password',
    });
    expect(await db`select 1 from users where email = 'x@example.com'`).toHaveLength(0);
  });
});
