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
