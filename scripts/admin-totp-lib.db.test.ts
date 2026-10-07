/**
 * 职责：`npm run admin:totp` 的库侧（P1-5 / AJ-386）——真 Postgres。
 * @why 开通 / 关闭第二因素必须让**已签出的 token 全部失效**（token_ver+1）：
 *      否则"发现账号可疑 → 开 TOTP"之后，攻击者手里那张 12 小时的 token 照样能退款。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../test/db/test-db.js';
import { disableAdminTotp, enableAdminTotp } from './admin-totp-lib.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  const { closeDb } = await import('../server/src/adapters/db.js');
  await closeDb(db);
});
beforeEach(async () => {
  await resetTestDb(db);
  await db`
    insert into users (id, email, password_hash, is_admin, token_ver)
    values ('u-a', 'Boss@Example.com', 'x', true, 3), ('u-s', 'staff@example.com', 'x', false, 1)`;
});

const row = async (id: string) =>
  (await db`select totp_secret, totp_last_step, token_ver from users where id = ${id}`)[0];

describe('enableAdminTotp / disableAdminTotp', () => {
  it('🔴 开通：写入新密钥、清步数、token_ver+1；返回 otpauth URI；审计一行（不含密钥）', async () => {
    await db`update users set totp_last_step = 99 where id = 'u-a'`;
    const r = await enableAdminTotp(db, 'boss@example.com');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = await row('u-a');
    expect(u?.['totp_secret']).toBe(r.secret);
    expect(u?.['totp_last_step']).toBeNull();
    expect(u?.['token_ver']).toBe(4);
    expect(r.uri).toContain(`secret=${r.secret}`);
    const audit = await db`select action, target, before, after from admin_audit`;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['action']).toBe('CLI admin.totp.enable');
    expect(JSON.stringify(audit[0])).not.toContain(r.secret);
  });

  it('再开一次 = 换密钥（旧 App 里的码作废）', async () => {
    const a = await enableAdminTotp(db, 'boss@example.com');
    const b = await enableAdminTotp(db, 'boss@example.com');
    expect(a.ok && b.ok && a.secret !== b.secret).toBe(true);
  });

  it('关闭：清密钥与步数、token_ver+1、审计', async () => {
    await enableAdminTotp(db, 'boss@example.com');
    const r = await disableAdminTotp(db, 'boss@example.com');
    expect(r).toEqual({ ok: true });
    const u = await row('u-a');
    expect(u?.['totp_secret']).toBeNull();
    expect(u?.['token_ver']).toBe(5);
  });

  it('非管理员 / 不存在 → admin_not_found，库不动', async () => {
    expect(await enableAdminTotp(db, 'staff@example.com')).toEqual({
      ok: false,
      reason: 'admin_not_found',
    });
    expect((await row('u-s'))?.['totp_secret']).toBeNull();
    expect(await disableAdminTotp(db, 'ghost@example.com')).toEqual({
      ok: false,
      reason: 'admin_not_found',
    });
  });
});
