/**
 * 职责：`npm run admin:revoke` 的库侧（管理员离职处置，运维手册 §5）——真 Postgres。
 * @why 此前没有"撤销管理员"的命令，手册只能写"重设口令 + 换手机密钥"的临时办法；
 *      离职的人账号仍是 is_admin=true，一旦口令或密钥任一泄露就还能进后台。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../test/db/test-db.js';
import { revokeAdmin } from './admin-revoke-lib.js';

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
    insert into users (id, email, password_hash, is_admin, token_ver, totp_secret)
    values ('u-boss', 'Boss@Example.com', 'x', true, 3, 'JBSWY3DPEHPK3PXP'),
           ('u-ops', 'Ops.Leaver@Example.com', 'x', true, 5, 'JBSWY3DPEHPK3PXQ'),
           ('u-staff', 'staff@example.com', 'x', false, 1, null)`;
});

const row = async (id: string) =>
  (
    await db`select is_admin, token_ver, totp_secret, totp_last_step from users where id = ${id}`
  )[0];

describe('revokeAdmin', () => {
  it('🔴 撤销：is_admin=false、token_ver+1（所有会话立即失效）、清手机密钥；审计一行；邮箱不分大小写', async () => {
    const r = await revokeAdmin(db, 'ops.leaver@example.com');
    expect(r).toEqual({ ok: true, userId: 'u-ops' });
    expect(await row('u-ops')).toMatchObject({
      is_admin: false,
      token_ver: 6,
      totp_secret: null,
      totp_last_step: null,
    });
    expect((await row('u-boss'))?.['is_admin']).toBe(true); // 别人不受影响
    const audit = await db`select actor, action, target, before, after from admin_audit`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'cli:admin-revoke',
      action: 'CLI admin.revoke',
      target: 'u-ops',
      before: { is_admin: true },
      after: { is_admin: false },
    });
    expect(JSON.stringify(audit[0])).not.toContain('JBSWY3');
  });

  it('🔴 最后一个管理员不能撤（否则谁都进不了后台）：拒绝且不改动、不写审计', async () => {
    await revokeAdmin(db, 'ops.leaver@example.com');
    const r = await revokeAdmin(db, 'boss@example.com');
    expect(r).toEqual({ ok: false, reason: 'last_admin' });
    expect(await row('u-boss')).toMatchObject({ is_admin: true, token_ver: 3 });
    expect(await db`select 1 from admin_audit where target = 'u-boss'`).toHaveLength(0);
  });

  it('不存在的邮箱 / 不是管理员 → admin_not_found，不改动', async () => {
    expect(await revokeAdmin(db, 'ghost@example.com')).toEqual({
      ok: false,
      reason: 'admin_not_found',
    });
    expect(await revokeAdmin(db, 'staff@example.com')).toEqual({
      ok: false,
      reason: 'admin_not_found',
    });
    expect((await row('u-staff'))?.['token_ver']).toBe(1);
  });

  it('被拉黑的管理员不算"还能进后台的人"：只剩一个可用管理员时同样拒绝撤它', async () => {
    await db`update users set blocked_at = now() where id = 'u-ops'`;
    expect(await revokeAdmin(db, 'boss@example.com')).toEqual({ ok: false, reason: 'last_admin' });
  });
});
