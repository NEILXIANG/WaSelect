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

  /**
   * B48 ①：**不存在的邮箱也要付一次 bcrypt**（DUMMY_HASH）。
   *
   * @why 上面那条只钉住了"答复逐字相同"，钉不住**耗时**：不存在的邮箱若直接 `return false`，
   *      响应会快整整一次 bcrypt（cost 10，@measured 本机 93ms），
   *      于是"401 来得快还是慢"就能问出这个邮箱注册过没有——登录口又变回邮箱探测器，
   *      而且这一次**响应体完全一样**，上面那条用例依然是绿的。
   *      所以这条必须单独钉，且只能靠耗时钉（这是它唯一的观测面）。
   * @limitation 阈值 40ms 是**下界**判据：bcrypt 只会更慢不会更快（CPU 成本固定、
   *      机器越忙越慢），所以这条不会误判成"没比对"；反过来它**不**保证"两者耗时相同"
   *      （那是统计性质，用例里测不了）。若将来把 `BCRYPT_COST` 调低，这条阈值要跟着调。
   */
  it('🔴 不存在的邮箱也付一次 bcrypt（DUMMY_HASH）：不是"查不到就立刻回"', async () => {
    const t0 = Date.now();
    const ghost = await login('ghost@example.com', 'definitely-not-it');
    const ghostMs = Date.now() - t0;
    expect(ghost.status).toBe(401);
    // 对照：形状错误（40001）连 bcrypt 都不跑，是"不比对"那一侧的耗时
    const t1 = Date.now();
    const bad = await login('', 'definitely-not-it');
    const shapeMs = Date.now() - t1;
    expect(bad.status).toBe(400);
    // @measured（bcryptjs cost 10，本机）一次 compare ≈ 93ms；阈值 40 留了一倍余量
    expect(ghostMs, '不存在的邮箱没有付 bcrypt ⇒ 登录口又成了邮箱探测器').toBeGreaterThan(40);
    expect(shapeMs, '形状错误不该跑 bcrypt（对照组本身要成立）').toBeLessThan(40);
  });

  /**
   * B48 ②：**失败路径的日志不含邮箱明文**（约束七）。
   *
   * @why 成功路径那句"日志有 target_user_id 无邮箱明文"已经钉住了 200 那一侧，
   *      而失败路径（40101 / 42901）**从来没人断言过**——恰恰失败才是"把入参打进日志"最容易发生的地方
   *      （排查登录问题的人第一反应就是把 email 塞进 ctx）。
   *      `admin_audit` 是 append-only，运行日志有保留期，邮箱一旦进去就是持久的账号枚举清单。
   */
  it('🔴 失败路径（口令错 / 不存在 / 被锁）的日志里没有任何一处邮箱明文', async () => {
    await login(EMAIL, 'definitely-not-it');
    await login('ghost@example.com', 'definitely-not-it');
    for (let i = 1; i <= ADMIN_LOGIN_MAX_FAILURES; i += 1) {
      await login(EMAIL, `wrong-password-${String(i)}`);
    }
    const text = JSON.stringify(srv.sink.lines).toLowerCase();
    expect(text).toContain('admin_login_failed');
    expect(text).toContain('admin_login_locked');
    expect(text).not.toContain(EMAIL.toLowerCase());
    expect(text).not.toContain('ghost@example.com');
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
    /**
     * ⚠️ 上界与"正确口令有没有抢到额度"有关（SEC2-10 / AJ-345）。
     *    旧断言写的是"走到比对的总数恒 ≤ max"——那在一种情形下是**错的**：
     *    正确口令抢到额度 ⇒ 登录成功会把两层清零（`clearLoginAttempt`），
     *    清零**之后**才 claim 的请求拿到的是**新一轮**额度 ⇒ 总数上界变成 2×max。
     *    触发条件是"某个请求的 claim 晚于正确口令那次 bcrypt 完成（~100ms）"，
     *    机器忙时才可能出现 ⇒ 旧断言表现为**偶发红**，而实现并没有坏：
     *    成功登录重置计数本来就是产品上要的行为。
     *    所以上界按 `ok` 分情况写，而不是写死 max。
     */
    const comparedCap = ADMIN_LOGIN_MAX_FAILURES * (ok === 1 ? 2 : 1);
    expect(bad + ok).toBeLessThanOrEqual(comparedCap);
    expect(bad).toBeGreaterThanOrEqual(ADMIN_LOGIN_MAX_FAILURES - 1);
    expect(ok).toBeLessThanOrEqual(1);
    expect(locked).toBeGreaterThanOrEqual(31 - comparedCap);
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
   * 第二轮审查 SEC2-07：**额度键（JS `toLowerCase`）与查人（PG `lower()`）不是同一个函数**。
   *
   * @measured(psql -d japan_shop_test, 2026-10-03, datcollate=en_US.UTF-8)：
   *   PG `lower('İ')` = `i`（1 个码位）；JS `'İ'.toLowerCase()` = `i` + U+0307（2 个码位）。
   *   于是 `Ops.Admİn@Example.com` 经 PG 的 `lower()` **查得到** `Ops.Admin@Example.com` 这个人，
   *   而额度键落在 JS 归一的**另一个桶**里 ⇒ 同一个账号有多个额度桶，邮箱桶的 30 次上限可被绕过。
   *
   * @why 这条必须钉在**真库**上：差异的一半在 PG 里（它怎么折 `İ` 取决于 collation），
   *      用替身 Db 或只在 JS 侧断言都验不到"查得到人"那一半。
   */
  it('🔴 İ 扮演 i：不能再查到真账号（否则同一个账号有多个额度桶，封顶被绕过）', async () => {
    const homoglyph = 'Ops.Admİn@Example.com';
    const homoglyphKey = loginAttemptKey(homoglyph);
    expect(homoglyphKey).not.toBe(ADMIN_KEY);
    const r = await login(homoglyph, PASSWORD);
    // 修复前：PG 把它折成 'ops.admin@example.com' ⇒ 查到真管理员、口令对 ⇒ **200**（且清了真账号的桶）
    expect(r.status).toBe(401);
    expect(r.json['code']).toBe(40101);
    // 这一笔记在它自己那个桶里（修复前：登录成功 ⇒ 这一格被清成 0，等于影子桶没被计费）
    expect((await attemptRow(homoglyphKey)).failedCount).toBe(1);
    // 真账号照常可登（不受这个"影子桶"影响）
    expect((await login(EMAIL, PASSWORD)).status).toBe(200);
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

/**
 * SEC2-08 的**第二个** 42901 出口：**口令比对那 ~100ms 里被别的请求上了锁**。
 *
 * @why 这段（admin-auth-routes.ts 的 `clearedSource/clearedEmail === 'locked'` 分支）此前**零覆盖**——
 *      它是 `npm run gate` 覆盖率底线唯一拦下的地方（functions 5/7、statements 48/54），
 *      也就是说 SEC2-08 那条修复**加了代码没加用例**，上线与否全靠覆盖率底线偶然发现。
 *      而它恰好是最容易悄悄坏的一种：契约写"锁定期 42901 + Retry-After"，
 *      这个出口曾经**不设**头，于是同一个 42901 有两种响应形状，而所有既有用例都只走另一个出口。
 *
 * @why **不能**靠真并发去撞这个窗口来测：bcrypt 只有 ~93ms 的缝，撞得上与否是随机的。
 *      偶发红的用例下一次会被人加 `.skip`，那比没有这条用例更糟（§2 第 14 条：
 *      别把"随机红"先归因给机器慢）。这里用的是**确定性插入**——真库 + 一个
 *      在"查凭证"那一步替并发者插一脚的 Db 替身。
 *      ⚠️ 插入点**必须**在两次 claim **之后**：插在之前的话 ⓪ 的 `peekLoginAttemptLock`
 *      会先把它拒掉，走的是另一个出口 —— 那条用例就变成了自我安慰（看起来在测"被并发上锁"，
 *      实际测的是"进来时就已锁"，而后者早有其它用例钉着）。
 */
describe('SEC2-08：口令比对期间被别的请求上了锁（42901 的第二个出口）', () => {
  const LOCK_SECONDS = ADMIN_LOGIN_LOCK_MINUTES * 60;
  /** 邮箱桶故意锁得**更早**：两个桶都锁着时 retry-after 必须给更晚的那个（下面 ② 钉的就是它）。 */
  const EMAIL_LOCK_SECONDS = 600;

  beforeEach(async () => {
    const sourceUntil = new Date(Date.now() + LOCK_SECONDS * 1000);
    const emailUntil = new Date(Date.now() + EMAIL_LOCK_SECONDS * 1000);
    let armed = true;
    /**
     * 只在"查凭证"这一次插脚：它在两次 claim 之后、两次 clear 之前，
     * 正是真实竞态（"我比对口令的时候别人把锁打上了"）所在的位置。
     *
     * @limitation 这是**替身 Db**：只有模板调用形态（`db\`…\``）被转发，
     *             真 `Db` 的 `.begin` 等成员没有。登录链路只用模板调用，所以够用；
     *             哪天登录口改用事务，这里会以"某个方法不存在"炸出来——
     *             炸出来是好事（比静默地不插脚好）。
     */
    const passthrough = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> =>
      (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(
        strings,
        ...values,
      );
    const proxy = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!armed || !strings.join(' ').includes('lower(email) =')) {
        return passthrough(strings, ...values);
      }
      armed = false;
      // 并发者做的事：**两个桶都锁上**（值必须 ≠ 本次 claim 拿到的 ownLockUntil，否则会被自己清掉）。
      // 锁两个而不是一个，是为了让"取更晚的那个"这条逻辑真的被执行到——
      // 只锁一个桶时 `.reduce` 只有一次迭代，"两个都在、该报哪个"这条永远验不到。
      return db`
        update login_attempts
           set locked_until = ${sourceUntil}, failed_count = ${ADMIN_LOGIN_MAX_FAILURES}
         where key_hash = ${ADMIN_SOURCE_KEY}
      `
        .then(
          () => db`
        update login_attempts
           set locked_until = ${emailUntil}, failed_count = ${ADMIN_LOGIN_GLOBAL_MAX_FAILURES}
         where key_hash = ${ADMIN_KEY}
      `,
        )
        .then(() => passthrough(strings, ...values));
    }) as unknown as Db;
    srv = await buildChainServer(proxy, { RATE_LIMIT_LOGIN_PER_15MIN: '1000' });
  });

  it('🔴 也要带 retry-after，且给的是"锁还剩多久"而不是兜底的 1', async () => {
    const r = await login(EMAIL, PASSWORD);
    expect(r.status).toBe(429);
    expect(r.json['code']).toBe(42901);
    expect(r.json['token']).toBeUndefined();

    // ① 头必须在（修复前这个出口根本不设 → 同一个 42901 有两种形状）
    const retryAfter = Number(r.headers.get('retry-after'));
    expect(Number.isFinite(retryAfter)).toBe(true);
    // ② 且不是兜底的 1：给的是"锁还有多久"，不是"一秒后再试"
    expect(retryAfter).toBeGreaterThan(1);
    // ③ 两个桶都锁着时给的是**更晚**的那个（来源桶 15 分钟 > 邮箱桶 10 分钟）——
    //    给早的那个会让客户端在邮箱桶解锁后、来源桶还锁着时白重试一轮
    expect(retryAfter).toBeGreaterThan(EMAIL_LOCK_SECONDS);
    expect(retryAfter).toBeLessThanOrEqual(LOCK_SECONDS);

    // ④ 走的确实是"比对期间被锁"这个出口，不是 ⓪ 的"进来时邮箱桶就已锁"
    const warns = srv.sink.find('admin_login_locked');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.['ctx']).toEqual({ reason: 'locked_while_verifying' });
    // ⑤ 口令是对的，但绝不发 token：命中锁的那一次不能因为"他证明了他自己"就放行
    expect(srv.sink.find('admin_login_ok')).toHaveLength(0);
  });
});
