/**
 * 职责：`POST /auth/admin/login`（管理员邮箱密码登录，D-38 ⑤；O-11 / AJ-181）——生产装配 + 真库。
 *
 * @why 此前契约写着、admin-web 调着，服务端却没有这条路由：生产上管理端**无法登录**，
 *      而本地一直靠测试里手签 admin token 绕过去（所以所有管理端测试都是绿的）。
 * @why 钉的是四类"看起来能用、实际是坏的"：
 *      ① 不存在的邮箱与密码错**给同一个答复**（否则登录口就是一个邮箱探测器）；
 *      ② 连续失败锁账号（账号维度），且锁住时**正确密码也不放**；
 *      ③ 非管理员 / 已封禁的账号密码对了也不发 admin token；
 *      ④ 签出的 token 真能过管理端守卫（aud=admin、ver 与库一致）——只验"返回了个字符串"等于没验。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { buildChainServer, call, type ChainServer } from '../../../test/helpers/chain-server.js';
import { hashPassword } from './auth.js';
import { ADMIN_LOGIN_LOCK_MINUTES, ADMIN_LOGIN_MAX_FAILURES } from './admin-auth-routes.js';

const EMAIL = 'Ops.Admin@Example.com';
const PASSWORD = 'correct horse battery staple';

let db: Db;
let srv: ChainServer;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  const hash = await hashPassword(PASSWORD);
  await db`
    insert into users (id, email, password_hash, is_admin)
    values ('u-adm', ${EMAIL}, ${hash}, true),
           ('u-staff', 'staff@example.com', ${hash}, false)`;
});

afterEach(async () => {
  await srv.close();
});

const login = (email: string, password: string) =>
  call(srv, 'POST', '/api/v1/auth/admin/login', { body: { email, password } });

async function userRow(id: string) {
  const [u] = await db`
    select failed_login_count, login_locked_until from users where id = ${id}`;
  return {
    failures: Number(u?.['failed_login_count']),
    lockedUntil: u?.['login_locked_until'] as Date | null,
  };
}

describe('POST /auth/admin/login（账号维度锁定；IP 限流放宽以免混淆）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db, { RATE_LIMIT_LOGIN_PER_15MIN: '100' });
  });

  it('邮箱大小写不敏感 → 200 {token}；token 能过管理端守卫；日志有 target_user_id 无邮箱明文', async () => {
    // token_ver ≠ 1：签出的 token 必须带库里的版本（改密/封禁即时失效 D25），写死 1 会被守卫拒
    await db`update users set token_ver = 3 where id = 'u-adm'`;
    const r = await login('ops.admin@example.com', PASSWORD);
    expect(r.status).toBe(200);
    const token = String(r.json['token']);
    expect(token.split('.')).toHaveLength(3);
    const list = await call(srv, 'GET', '/api/v1/admin/orders', { token });
    expect(list.status).toBe(200);
    const ok = srv.sink.find('admin_login_ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]?.['target_user_id']).toBe('u-adm');
    expect(JSON.stringify(srv.sink.lines).toLowerCase()).not.toContain('ops.admin@example.com');
  });

  it('密码错与邮箱不存在 → 同一个 40101（响应体逐字相同）；只有真账号计失败次数', async () => {
    const wrong = await login(EMAIL, 'definitely-not-it');
    const ghost = await login('ghost@example.com', 'definitely-not-it');
    expect(wrong.status).toBe(401);
    expect(wrong.json['code']).toBe(40101);
    expect(ghost.json).toEqual(wrong.json);
    expect((await userRow('u-adm')).failures).toBe(1);
    expect(srv.sink.find('admin_login_failed')).toHaveLength(2);
  });

  it(`连续失败 ${ADMIN_LOGIN_MAX_FAILURES} 次 → 锁 ${ADMIN_LOGIN_LOCK_MINUTES} 分钟：锁住时正确密码也 429；到期后可登且计数清零`, async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await login(EMAIL, `wrong-password-${String(i)}`)).status).toBe(401);
    }
    const u = await userRow('u-adm');
    expect(u.lockedUntil).not.toBeNull();
    const lockMs = (u.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(lockMs).toBeGreaterThan((ADMIN_LOGIN_LOCK_MINUTES - 1) * 60_000);
    expect(lockMs).toBeLessThanOrEqual(ADMIN_LOGIN_LOCK_MINUTES * 60_000);

    const locked = await login(EMAIL, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.json['code']).toBe(42901);
    expect(srv.sink.find('admin_login_locked')).toHaveLength(1);

    await db`update users set login_locked_until = now() - interval '1 second' where id = 'u-adm'`;
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    expect(await userRow('u-adm')).toEqual({ failures: 0, lockedUntil: null });
  });

  it('非管理员 / 已封禁的管理员：密码对也不发 admin token → 40301', async () => {
    const staff = await login('staff@example.com', PASSWORD);
    expect(staff.status).toBe(403);
    expect(staff.json['code']).toBe(40301);
    // 口令错时不能先说"你不是管理员"——那等于不用猜口令就能问出谁是管理员
    expect((await login('staff@example.com', 'wrong-password-x')).json['code']).toBe(40101);
    await db`update users set blocked_at = now() where id = 'u-adm'`;
    expect((await login(EMAIL, PASSWORD)).json['code']).toBe(40301);
  });

  it('参数形状：密码短于 12 位 / 缺邮箱 → 40001（契约 minLength 12）', async () => {
    expect((await login(EMAIL, 'short')).json['code']).toBe(40001);
    const noEmail = await call(srv, 'POST', '/api/v1/auth/admin/login', {
      body: { password: PASSWORD },
    });
    expect(noEmail.json['code']).toBe(40001);
  });
});

describe('POST /auth/admin/login（IP 限流，D-52）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db, { RATE_LIMIT_LOGIN_PER_15MIN: '2' });
  });

  it('同一 IP 第 3 次（limit=2）→ 429 42901，即使密码正确', async () => {
    expect((await login(EMAIL, 'wrong-password-1')).status).toBe(401);
    expect((await login(EMAIL, 'wrong-password-2')).status).toBe(401);
    const third = await login(EMAIL, PASSWORD);
    expect(third.status).toBe(429);
    expect(third.json['code']).toBe(42901);
  });
});
