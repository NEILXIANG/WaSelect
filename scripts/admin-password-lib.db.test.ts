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
import { parseAdminPasswordArgs, setAdminPassword } from './admin-password-lib.js';
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

describe('parseAdminPasswordArgs（CLI 参数）', () => {
  it('两个位置参数 → 入参；多余参数忽略', () => {
    expect(parseAdminPasswordArgs(['a@b.c', 'pw-1234567890', '--force'])).toEqual({
      email: 'a@b.c',
      password: 'pw-1234567890',
    });
  });

  it('缺参 / 空串 / 全空白邮箱 → undefined（调用方应打印用法并退出非 0）', () => {
    expect(parseAdminPasswordArgs([])).toBeUndefined();
    expect(parseAdminPasswordArgs(['a@b.c'])).toBeUndefined();
    expect(parseAdminPasswordArgs(['a@b.c', ''])).toBeUndefined();
    expect(parseAdminPasswordArgs(['   ', 'pw-1234567890'])).toBeUndefined();
  });
});
