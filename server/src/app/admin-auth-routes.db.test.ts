/**
 * 职责：`POST /auth/admin/login`（管理员邮箱密码登录，D-38 ⑤；O-11 / AJ-181 / AJ-187）——生产装配 + 真库。
 *
 * @why 此前契约写着、admin-web 调着，服务端却没有这条路由：生产上管理端**无法登录**，
 *      而本地一直靠测试里手签 admin token 绕过去（所以所有管理端测试都是绿的）。
 * @why 钉的是四类"看起来能用、实际是坏的"：
 *      ① 不存在的邮箱与密码错**给同一个答复**（否则登录口就是一个邮箱探测器）；
 *      ② 连续失败锁账号（账号维度），且锁住时**正确密码也不放**；
 *      ③ 非管理员 / 已封禁的账号密码对了也不发 admin token；
 *      ④ 签出的 token 真能过管理端守卫（aud=admin、ver 与库一致）——只验"返回了个字符串"等于没验。
 * @why ② 的**并发**形态单独成例（A1）：额度扣在 bcrypt 之前，所以并发 30 个错误口令
 *      只能有 ≤max 个真正走到比对，其余全部 429——单线程下"连错 5 次会锁"说明不了这件事
 *      （旧实现单线程也锁，只是并发时 N 个请求全部读到"未锁"）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  buildChainServer,
  call,
  tokenFor,
  type ChainServer,
} from '../../../test/helpers/chain-server.js';
import { ADMIN_PASSWORD_MIN_LENGTH } from '@waselect/shared';
import { hashPassword, PASSWORD_MAX_CHARS } from './auth.js';
import { loginAttemptKey, loginAttemptSourceKey } from '../adapters/admin-auth.js';
import {
  ADMIN_LOGIN_GLOBAL_MAX_FAILURES,
  ADMIN_LOGIN_LOCK_MINUTES,
  ADMIN_LOGIN_MAX_FAILURES,
} from './admin-auth-routes.js';

const EMAIL = 'Ops.Admin@Example.com';
const PASSWORD = 'correct horse battery staple';
const ADMIN_KEY = loginAttemptKey(EMAIL);
/**
 * 本机用例的来源桶（AJ-243）：fetch 从 127.0.0.1 发出，`req.ip` 是 `::ffff:127.0.0.1`，经 ipKey 归一为 `127.0.0.1`。
 * 连错 5 次锁的是**这个**桶（来源桶），不是邮箱桶（邮箱桶的上限是 30）。
 */
const ADMIN_SOURCE_KEY = loginAttemptSourceKey(EMAIL, '127.0.0.1');
const GHOST_KEY = loginAttemptKey('ghost@example.com');

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

async function attemptRow(keyHash: string) {
  const [r] = await db`
    select failed_count, locked_until from login_attempts where key_hash = ${keyHash}`;
  return {
    failedCount: Number(r?.['failed_count'] ?? -1),
    lockedUntil: (r?.['locked_until'] as Date | null | undefined) ?? null,
  };
}

describe('POST /auth/admin/login（账号维度锁定；IP 限流放宽以免混淆）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db, { RATE_LIMIT_LOGIN_PER_15MIN: '1000' });
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

  it('密码错与邮箱不存在 → 同一个 40101（响应体逐字相同）；两个键各计一次', async () => {
    const wrong = await login(EMAIL, 'definitely-not-it');
    const ghost = await login('ghost@example.com', 'definitely-not-it');
    expect(wrong.status).toBe(401);
    expect(wrong.json['code']).toBe(40101);
    expect(ghost.json).toEqual(wrong.json);
    expect((await attemptRow(ADMIN_KEY)).failedCount).toBe(1);
    expect((await attemptRow(GHOST_KEY)).failedCount).toBe(1);
    expect(srv.sink.find('admin_login_failed')).toHaveLength(2);
  });

  it(`连续失败 ${ADMIN_LOGIN_MAX_FAILURES} 次 → 锁 ${ADMIN_LOGIN_LOCK_MINUTES} 分钟：锁住时正确密码也 429；到期后可登且计数清零`, async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await login(EMAIL, `wrong-password-${String(i)}`)).status).toBe(401);
    }
    // AJ-243：锁的是**来源桶**；邮箱桶此时只累计了 5 次（上限 30），不锁
    const u = await attemptRow(ADMIN_SOURCE_KEY);
    expect(u.lockedUntil).not.toBeNull();
    expect(await attemptRow(ADMIN_KEY)).toEqual({ failedCount: 5, lockedUntil: null });
    const lockMs = (u.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(lockMs).toBeGreaterThan((ADMIN_LOGIN_LOCK_MINUTES - 1) * 60_000);
    expect(lockMs).toBeLessThanOrEqual(ADMIN_LOGIN_LOCK_MINUTES * 60_000);

    const locked = await login(EMAIL, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.json['code']).toBe(42901);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(srv.sink.find('admin_login_locked')).toHaveLength(1);

    await db`update login_attempts set locked_until = now() - interval '1 second' where key_hash = ${ADMIN_SOURCE_KEY}`;
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
    // 登录成功：两层都清零
    expect(await attemptRow(ADMIN_SOURCE_KEY)).toEqual({ failedCount: 0, lockedUntil: null });
    expect(await attemptRow(ADMIN_KEY)).toEqual({ failedCount: 0, lockedUntil: null });
  });

  /**
   * R-02 / AJ-224：A1 修复引入的回归——**最后一次额度输对口令也被拒，还顺手把自己锁 15 分钟**。
   * @why 第 max 次 `claim` 在同一条语句里就把 `locked_until` 置上了（返回的仍是 claimed）；
   *      口令比对通过后 `clearLoginAttempt` 的"未锁定"条件不成立 ⇒ `locked` ⇒ 42901。
   *      `admin-auth.ts` 的 @limitation 与 AJ-187 写的都是"第 5 次输对了不能被拒"，实现正相反。
   *      真实形态：管理员记错口令试了 4 次，第 5 次想起来了——被锁，且要等 15 分钟。
   */
  it(`🔴 错 ${ADMIN_LOGIN_MAX_FAILURES - 1} 次、第 ${ADMIN_LOGIN_MAX_FAILURES} 次输对 → 200，且额度清零（不把自己锁住）`, async () => {
    for (let i = 1; i < ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await login(EMAIL, `wrong-password-${String(i)}`)).status).toBe(401);
    }
    const ok = await login(EMAIL, PASSWORD);
    expect(ok.status).toBe(200);
    expect(await attemptRow(ADMIN_KEY)).toEqual({ failedCount: 0, lockedUntil: null });
    expect(srv.sink.find('admin_login_locked')).toHaveLength(0);
  });

  it(`第 ${ADMIN_LOGIN_MAX_FAILURES} 次仍输错 → 锁生效：此后正确口令也 429（上一条的例外不放宽封顶）`, async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await login(EMAIL, `wrong-password-${String(i)}`)).status).toBe(401);
    }
    expect((await login(EMAIL, PASSWORD)).status).toBe(429);
  });

  /**
   * A1 的落点：额度扣在 bcrypt **之前**，所以并发突发下"能拿到的比对次数"被真正封顶。
   * @why 断言的是**401 的条数 ≤ max**，不是"最终会锁"——旧实现最终也会锁，
   *      但它挡不住"同一瞬间冲进来 30 个请求全部走完比对"。
   */
  it(`A1：并发 30 个错误口令 + 1 个正确口令 → 真正走到口令比对的不超过 ${ADMIN_LOGIN_MAX_FAILURES} 次，其余全 42901`, async () => {
    const burst = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => login(EMAIL, `wrong-password-${String(i)}`)),
      login(EMAIL, PASSWORD),
    ]);
    const codes = burst.map((r) => r.json['code'] ?? r.status);
    expect(codes).toHaveLength(31);
    const bad = codes.filter((c) => c === 40101).length;
    const ok = burst.filter((r) => r.status === 200).length;
    const locked = codes.filter((c) => c === 42901).length;
    /**
     * ⚠️ 这里原来断言"40101 **恰好** max 条、正确口令**一定**拿不到 token"——那是把
     * "正确口令最后一个到达"当成了前提（AJ-224）。31 个请求并发到达的顺序不由用例决定：
     * 正确口令若抢到 5 个额度之一，40101 就只有 4 条。旧断言因此是**偶发红**，
     * 而它想守的不变量其实与顺序无关——
     *   · 走到口令比对的请求数 ≤ max（封顶，A1 的全部意义）；
     *   · 三种结局加起来恰好 31（没有第四种出口，比如 500）；
     *   · 正确口令至多成功 1 次，且只有在它持有额度时才可能成功。
     */
    expect(bad + ok + locked).toBe(31);
    expect(bad + ok).toBeLessThanOrEqual(ADMIN_LOGIN_MAX_FAILURES);
    expect(bad).toBeGreaterThanOrEqual(ADMIN_LOGIN_MAX_FAILURES - 1);
    expect(ok).toBeLessThanOrEqual(1);
    expect(locked).toBeGreaterThanOrEqual(31 - ADMIN_LOGIN_MAX_FAILURES);
    expect(srv.sink.find('admin_login_ok')).toHaveLength(ok);
    expect(srv.sink.find('admin_login_locked').length).toBeGreaterThan(0);
  });

  it('B14：不存在的邮箱连错同样次数后也 429——「429 还是 401」不再能问出邮箱是否注册过', async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await login('ghost@example.com', `wrong-password-${String(i)}`)).json['code']).toBe(
        40101,
      );
    }
    const sixth = await login('ghost@example.com', 'wrong-password-6');
    expect(sixth.status).toBe(429);
    expect(sixth.json['code']).toBe(42901);
    // 同一时刻真实账号不受牵连（键之间互不干扰）
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
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

  /**
   * 第二轮审查 SEC2-06：登录成功时**不清本进程的身份缓存**，于是改密之后的第一次重登
   * 拿到的是"新口令签的新 token、却被旧缓存拒"——管理员看到"刚登录就过期"的循环。
   *
   * @why 这条要钉的是**端到端**那一段：`requireRole` 的回源比对（`identity.load`）带 60 秒缓存，
   *      而改密脚本只改库里的 `token_ver`、调不到服务进程的 `invalidate`。
   *      改密恰恰是应急动作（口令可能已泄露），"改完 60 秒登不上"最容易被误判成改密失败。
   */
  it('🔴 改密（token_ver+1）后重登：新 token **立刻**能过守卫，不被上一次登录留下的缓存拒成 40101', async () => {
    // ① 预热：用当前 ver 的 token 访问一次管理端路由，进程内缓存里就有了 {tokenVer: N}
    const warm = await call(srv, 'GET', '/api/v1/admin/orders', {
      token: await tokenFor('u-adm', 'admin', 1),
    });
    expect(warm.status).toBe(200);
    // ② 改密脚本做的事：`token_ver + 1`（旧 token 全部失效）
    await db`update users set token_ver = token_ver + 1 where id = 'u-adm'`;
    // ③ 用新口令重新登录（签名取的是库里的 ver，所以 token 与库一致）
    const relogin = await login(EMAIL, PASSWORD);
    expect(relogin.status).toBe(200);
    // ④ 立刻访问：缓存里那份旧的 tokenVer 若在，这里就是 40101（表现为"刚登录就过期"）
    const fresh = String(relogin.json['token']);
    expect((await call(srv, 'GET', '/api/v1/admin/orders', { token: fresh })).status).toBe(200);
  });
});

/**
 * 第二轮审查 SEC2-11 ③：登录口的口令长度上下限曾经是**两个字面量**（12 / 1024），
 * 而改密脚本与启动校验用的是 `packages/shared` 的 `ADMIN_PASSWORD_MIN_LENGTH`、
 * 校验侧用的是 `auth.ts` 的 `PASSWORD_MAX_CHARS`——三处里只有登录口没接常量。
 *
 * @why 漂移的形态是"改了常量 → 脚本能设出登录口拒收的口令"（或反过来），
 *      而它不会让任何现有用例变红：三处各自都能自圆其说。
 *      所以这里**从常量推**出边界值去打登录口，而不是再抄一份数字。
 */
describe('登录口的口令长度与共享常量同源（SEC2-11 ③）', () => {
  beforeEach(async () => {
    srv = await buildChainServer(db, { RATE_LIMIT_LOGIN_PER_15MIN: '1000' });
  });

  const login = (password: string) =>
    call(srv, 'POST', '/api/v1/auth/admin/login', { body: { email: EMAIL, password } });

  // ⚠️ 这两条**取不到红灯**（字面量与常量今天恰好相等），所以标题不带 🔴——
  //    真正的守卫是 admin-auth.unit.test.ts 里那条源码断言（§2 第 15 条）。
  it(`恰好 ${String(ADMIN_PASSWORD_MIN_LENGTH)} 位被形状校验放行（走到口令比对 → 40101，不是 40001）`, async () => {
    const exact = 'x'.repeat(ADMIN_PASSWORD_MIN_LENGTH);
    expect((await login(exact)).json['code']).toBe(40101);
    // 少一位即被拒：下限确实来自同一个常量
    expect((await login('x'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1))).json['code']).toBe(40001);
  });

  it(`超过 ${String(PASSWORD_MAX_CHARS)} 位被形状校验拒绝（上限与 verifyPassword 同口径）`, async () => {
    expect((await login('x'.repeat(PASSWORD_MAX_CHARS + 1))).json['code']).toBe(40001);
    // 恰好到上限不拒（走比对 → 40101）
    expect((await login('x'.repeat(PASSWORD_MAX_CHARS))).json['code']).toBe(40101);
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

/**
 * AJ-243（第二轮审查 SEC2-01，用户 2026-09-30 授权自主决定）：锁定按「邮箱 × 来源 IP」分桶，
 * 另设邮箱维度的全局上限——**一个 IP 只能锁住它自己**。
 *
 * @why 原来额度只按邮箱计、连错 5 次锁 15 分钟，而 IP 限流恰好也是 5 次 / 15 分钟：
 *      知道管理员邮箱的人用**一个** IP 就能让管理员一直登不上（每 15 分钟补 5 次）。
 *      按来源分桶之后，攻击者的 5 次只锁住攻击者自己那个来源；
 *      邮箱全局上限（30 次 / 15 分钟）保留"总尝试数有顶"——代价是攻击者要凑够 6 个来源才能锁死所有人。
 */
describe('POST /auth/admin/login：按来源分桶（AJ-243）', () => {
  beforeEach(async () => {
    // TRUST_PROXY_HOPS=1：用 x-forwarded-for 模拟不同来源（与生产经一层反代同形）
    srv = await buildChainServer(db, { RATE_LIMIT_LOGIN_PER_15MIN: '1000', TRUST_PROXY_HOPS: '1' });
  });

  const loginFrom = (ip: string, email: string, password: string) =>
    call(srv, 'POST', '/api/v1/auth/admin/login', {
      body: { email, password },
      headers: { 'x-forwarded-for': ip },
    });

  it('🔴 攻击者从 IP A 连错 5 次把 A 锁住 → 管理员从 IP B 用正确口令照常登录', async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await loginFrom('198.51.100.7', EMAIL, `wrong-password-${String(i)}`)).status).toBe(
        401,
      );
    }
    expect((await loginFrom('198.51.100.7', EMAIL, PASSWORD)).status).toBe(429); // A 自己被锁
    expect((await loginFrom('203.0.113.9', EMAIL, PASSWORD)).status).toBe(200); // B 不受影响
  });

  it('🔴 同一个 /64 里换 IPv6 后缀不算"换了来源"（否则分桶等于没有上限）', async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      await loginFrom(`2001:db8:1:2::${String(i)}`, EMAIL, `wrong-password-${String(i)}`);
    }
    expect((await loginFrom('2001:db8:1:2::99', EMAIL, PASSWORD)).status).toBe(429);
  });

  it(`🔴 邮箱全局上限：失败分散在多个来源、合计达到 ${ADMIN_LOGIN_GLOBAL_MAX_FAILURES} 次 → 任何来源都 429`, async () => {
    let n = 0;
    for (let ip = 1; n < ADMIN_LOGIN_GLOBAL_MAX_FAILURES; ip += 1) {
      for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES && n < ADMIN_LOGIN_GLOBAL_MAX_FAILURES; i += 1) {
        expect(
          (await loginFrom(`198.51.100.${String(ip)}`, EMAIL, `wrong-${String(n)}-xxxxxx`)).status,
        ).toBe(401);
        n += 1;
      }
    }
    expect((await loginFrom('203.0.113.200', EMAIL, PASSWORD)).status).toBe(429);
  });

  it('🔴 邮箱桶已被锁时重试**不扣**来源桶（PAY3-04）：锁到期后正确口令立刻 200，不是再等一轮', async () => {
    // 攻击者从不同来源把邮箱桶打满（这里直接置锁，等价于"合计 30 次"的终态）
    await db`
      insert into login_attempts (key_hash, failed_count, locked_until, first_failed_at, last_failed_at)
      values (${ADMIN_KEY}, 0, now() + interval '15 minutes', now(), now())
      on conflict (key_hash) do update set locked_until = now() + interval '15 minutes'
    `;
    // 管理员从自己的来源重试 5 次：全是 429（邮箱桶锁着），但**不该**记到他的来源桶上
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      expect((await loginFrom('203.0.113.9', EMAIL, PASSWORD)).status).toBe(429);
    }
    // 邮箱桶的锁到期 → 管理员应当能立刻登录（现状：他的来源桶被那 5 次扣满了 → 仍 429）
    await db`update login_attempts set locked_until = now() - interval '1 second' where key_hash = ${ADMIN_KEY}`;
    const r = await loginFrom('203.0.113.9', EMAIL, PASSWORD);
    expect(r.status).toBe(200);
  });

  it('来源不同的两个管理员同时存在：各自的失败互不影响（桶里有邮箱，不是只按 IP）', async () => {
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      await loginFrom('198.51.100.7', 'ghost@example.com', `wrong-password-${String(i)}`);
    }
    expect((await loginFrom('198.51.100.7', EMAIL, PASSWORD)).status).toBe(200);
  });
});
