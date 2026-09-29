/**
 * 职责：`adapters/admin-auth.ts`（放在 app/ 下：要用 app/auth.ts 的口令哈希，而 adapters 不得反向依赖 app；
 *      管理员凭据读取 / 失败计数与锁定 / 初始管理员 seed）真库用例（AJ-181）。
 *
 * @why 锁定逻辑写在**一条 SQL** 里（读-改-写在库内原子完成）：两次错误并发到达时，
 *      应用层"先读计数再写回"会各自读到 4、各自写 5——第 6 次还能试。这里钉住 SQL 的结果。
 * @why seed 只在"没有这个邮箱（大小写不敏感）"时建号，**绝不**改已存在账号的口令：
 *      env 里的 ADMIN_INITIAL_PASSWORD 常年不删，每次部署都覆盖一遍 = 管理员改过的口令被悄悄重置回初始值。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { hashPassword, verifyPassword } from './auth.js';
import {
  ensureInitialAdmin,
  findAdminCredential,
  recordLoginFailure,
  recordLoginSuccess,
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

describe('admin-auth 仓储', () => {
  it('findAdminCredential：按 lower(email) 找；不存在 → null', async () => {
    await db`insert into users (id, email, password_hash, is_admin) values ('u-a', 'A@x.com', 'h', true)`;
    const c = await findAdminCredential(db, 'a@X.COM');
    expect(c).toMatchObject({ id: 'u-a', isAdmin: true, passwordHash: 'h', failures: 0 });
    expect(await findAdminCredential(db, 'nobody@x.com')).toBeNull();
  });

  it('recordLoginFailure：第 max 次失败 → 锁到 now+lock 且计数归零；之前只累加', async () => {
    await db`insert into users (id, email, is_admin) values ('u-a', 'a@x.com', true)`;
    for (let i = 1; i < 3; i += 1) {
      expect(
        await recordLoginFailure(db, 'u-a', NOW, { maxFailures: 3, lockMinutes: 15 }),
      ).toBeNull();
    }
    const until = await recordLoginFailure(db, 'u-a', NOW, { maxFailures: 3, lockMinutes: 15 });
    expect(until?.toISOString()).toBe('2026-09-29T02:15:00.000Z');
    const [u] = await db`select failed_login_count from users where id = 'u-a'`;
    expect(u?.['failed_login_count']).toBe(0);
  });

  it('recordLoginFailure 并发：同时 5 次失败只会锁一次、计数不丢（库内原子读改写）', async () => {
    await db`insert into users (id, email, is_admin) values ('u-a', 'a@x.com', true)`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordLoginFailure(db, 'u-a', NOW, { maxFailures: 5, lockMinutes: 15 }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('recordLoginSuccess：计数与锁一起清', async () => {
    await db`
      insert into users (id, email, is_admin, failed_login_count, login_locked_until)
      values ('u-a', 'a@x.com', true, 3, ${NOW})`;
    await recordLoginSuccess(db, 'u-a');
    const [u] = await db`select failed_login_count, login_locked_until from users where id = 'u-a'`;
    expect(u).toEqual({ failed_login_count: 0, login_locked_until: null });
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
});
