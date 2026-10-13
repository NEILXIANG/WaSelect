/**
 * 职责：`adapters/admin-auth.ts` 里**不需要库**的那部分（登录额度键、清理基准时刻）——纯函数用例。
 *
 * @why 单独成文件而不是塞进 `admin-auth-store.db.test.ts`：这几个断言一毫秒就能跑完，
 *      放 db 测试里要为一个纯函数付一次建库 + 迁移的成本，而且 db 测试是多文件串行跑的。
 * @why 键的形状值得单独钉：`sha256(lower(trim(email)))` 这个顺序（先 trim 再 lower）决定了
 *      " ` A@X.com `" 与 "a@x.com" 是不是同一个键。写错顺序的后果不是报错，
 *      是"同一个人被当成两个人各数 5 次"——锁的强度悄悄减半，且没人会注意到。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import {
  ensureInitialAdmin,
  loginAttemptKey,
  loginAttemptsCutoff,
  LOGIN_ATTEMPT_RETENTION_HOURS,
  normalizeAdminEmail,
} from './admin-auth.js';

describe('loginAttemptKey', () => {
  it('大小写与前后空格不同 → 同一个键（与 findAdminCredential 的 lower(email) 同一口径）', () => {
    const base = loginAttemptKey('a@x.com');
    expect(loginAttemptKey('A@X.COM')).toBe(base);
    expect(loginAttemptKey('  a@x.com  ')).toBe(base);
  });

  it('不同邮箱 → 不同键；输出是 64 位小写 hex（列名 key_hash 的 CHECK 就是这条形状）', () => {
    expect(loginAttemptKey('a@x.com')).not.toBe(loginAttemptKey('b@x.com'));
    expect(loginAttemptKey('a@x.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不存邮箱明文（约束七脱敏红线：这张表会为根本不存在的邮箱建行）', () => {
    const key = loginAttemptKey('Ops.Admin@Example.com');
    expect(key).not.toContain('ops.admin');
    expect(Buffer.from(key, 'hex')).toHaveLength(32);
  });
});

/**
 * SEC2-07：额度键（JS `toLowerCase`）与查人（PG `lower()`）**必须是同一个归一结果**。
 *
 * @measured(psql -d japan_shop_test, 2026-10-03, datcollate=en_US.UTF-8)
 *   PG  `lower('İ')`          = `i`                       （1 个码位，ascii 105）
 *   JS  `'İ'.toLowerCase()`   = `i` + U+0307 组合点        （2 个码位，105 / 775）
 * @why 这个差异不是学术问题：`admİn@example.com` 经 PG 的 `lower()` **查得到** `admin@example.com`，
 *      而额度键是 JS 归一的结果 ⇒ **另一个桶**。邮箱里每有一个 `i` 就多一倍桶，
 *      AJ-243 "总尝试数由邮箱桶 30 次封顶"这条承诺可以被绕过。
 *      归一的**方向**因此必须是单向的：一律用 JS 的结果，PG 只对**库里的那一列**做 lower。
 */
describe('normalizeAdminEmail（SEC2-07：两个 lower 不是同一个函数）', () => {
  it('İ 在 JS 里变成 i + 组合点，不等于 PG 的 i —— 所以两个函数不能各归一一次', () => {
    const js = normalizeAdminEmail('admİn@example.com');
    expect(js.split('')).toHaveLength('admin@example.com'.length + 1); // i 后面多一个组合点
    expect(js).not.toBe('admin@example.com');
    // PG 侧（实测）会把同样的输入折成 'admin@example.com' —— 两个结果不同，正是分叉的来源
    expect(loginAttemptKey('admİn@example.com')).not.toBe(loginAttemptKey('admin@example.com'));
  });

  it('🔴 查人 / seed 判重都用 JS 归一结果，不再出现 `lower(${email})`（让 PG 再归一一次）', () => {
    const adminAuth = readFileSync(new URL('./admin-auth.ts', import.meta.url), 'utf8');
    const adminAuthCode = adminAuth
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
      .join('\n');
    // findAdminCredential 与 ensureInitialAdmin 两处都必须是这个形状
    expect(
      adminAuthCode.match(/lower\(email\) = \$\{normalizeAdminEmail\(email\)\}/g),
    ).toHaveLength(2);
    expect(adminAuthCode).not.toContain('lower(${email})');

    // 改密脚本：它清锁用的是 JS 归一的键，找人也必须同一份，否则会清掉一个没被锁的桶
    const script = readFileSync(
      new URL('../../../scripts/admin-password-lib.ts', import.meta.url),
      'utf8',
    );
    const scriptCode = script
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
      .join('\n');
    expect(scriptCode).toContain('lower(email) = ${normalizeAdminEmail(args.email)}');
    expect(scriptCode).not.toContain('lower(${args.email})');
  });
});

describe('loginAttemptsCutoff', () => {
  it(`基准时刻往前 ${LOGIN_ATTEMPT_RETENTION_HOURS} 小时（F10：由传入的时钟推导，不自己取 now）`, () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(loginAttemptsCutoff(now).toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });
});

/**
 * `ensureInitialAdmin` 的 catch 是**分诊**而不是"吞掉"（DB2-09 / AJ-324）。
 *
 * @why 两条各自钉一个方向，因为吞错方向的后果极不对称：
 *      · 把 23505 也抛出去 ⇒ 两个实例同时启动时**后到的那个**报启动失败，
 *        而它其实只需要承认"已经有了"——表现为"偶发起不来"，且只在多实例时发生；
 *      · 把别的错也当成 23505 ⇒ **连接失败 / 表不存在 被当成"账号已存在"**，
 *        启动照样成功、日志一片干净，而库里没有管理员 ⇒ 管理端无人可登，
 *        且 `admin:password` 也改不到一个不存在的账号。第二条更安静、更贵。
 * @limitation 两条都用"会抛指定 SQLSTATE 的替身 Db"，**不假装测到了并发**：
 *      23505 的真实来源是"两个实例同时建号"的竞态窗口，做成用例必然偶发红。
 *      这里只钉"错误码 → 语义"的映射本身；竞态形态本身按 🟡 登记在 AJ-324。
 */
describe('ensureInitialAdmin：catch 只认 23505，其余原样抛', () => {
  const dbThrowing = (code: string): Db => {
    const fn = (): never => {
      throw Object.assign(new Error('injected'), { code });
    };
    return fn as unknown as Db;
  };

  it('🔴 23505（并发里后到的那个）→ "exists"，启动继续', async () => {
    await expect(ensureInitialAdmin(dbThrowing('23505'), 'Boss@Example.com', 'hash')).resolves.toBe(
      'exists',
    );
  });

  it('🔴 非 23505（连接失败 / 表不存在）→ 原样抛，绝不静默当成"已有账号"', async () => {
    await expect(
      ensureInitialAdmin(dbThrowing('42P01'), 'Boss@Example.com', 'hash'),
    ).rejects.toThrow('injected');
    await expect(
      ensureInitialAdmin(dbThrowing('ECONNREFUSED'), 'Boss@Example.com', 'hash'),
    ).rejects.toThrow('injected');
  });
});

/**
 * A1 的落点**是时机，不是计数**：额度必须扣在 bcrypt **之前**。
 *
 * @why 单独的源码顺序断言：并发用例验的是"额度被扣了"，但"有没有扣"和"什么时候扣"是两件事——
 *      把扣额度挪到 bcrypt 之后，单线程下的锁定用例照样全绿，只有并发突发能看出差别，
 *      而并发用例在 CI 上有抖动风险（慢机器上 30 个请求未必真并发）。顺序断言是**确定性**的那一半守护。
 * @why 扫源码前先剥注释行（§2 第 54 条）：文件头注释里就写着 `claimLoginAttempt 在 bcrypt 之前执行`，
 *      不剥注释的话"把真实调用挪走、只留注释里的那句话"会让断言假绿——那正是本次要防的事。
 */
describe('登录路由的调用顺序（源码断言）', () => {
  const src = readFileSync(new URL('../app/admin-auth-routes.ts', import.meta.url), 'utf8');
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l, i) => ({ text: l, i }));
  const lineOf = (needle: string) => codeLines.find((l) => l.text.includes(needle))?.i ?? -1;

  it('claimLoginAttempt 在 verifyPassword 之前；clearLoginAttempt 在之后', () => {
    const claim = lineOf('claimLoginAttempt(');
    const verify = lineOf('verifyPassword(');
    const clear = lineOf('clearLoginAttempt(');
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(claim);
    expect(clear).toBeGreaterThan(verify);
  });

  /**
   * SEC2-11 ③：登录口的口令长度上下限必须是**引用常量**，不能是字面量。
   *
   * @why 行为用例钉不住这一条——字面量 12 / 1024 与 `ADMIN_PASSWORD_MIN_LENGTH` /
   *      `PASSWORD_MAX_CHARS` **今天恰好相等**，改任何一边都不会让"11 位被拒"这种断言变红。
   *      能红的只有源码断言：它守的是"两处是不是同一份事实"（约束九），不是"边界值对不对"。
   * @why 顺带断言这一行里**没有数字**：留着 `min(12)` 换成 `min(ADMIN_PASSWORD_MIN_LENGTH - 0)`
   *      之类的写法也算接了常量，但数字一进来就说明有人在重新引入第二份事实。
   */
  it('🔴 登录口 password 的 min/max 引用共享常量且不含任何数字字面量（SEC2-11 ③）', () => {
    const line = codeLines.find((l) => l.text.includes('password: z.string()'))?.text ?? '';
    expect(line).toContain('ADMIN_PASSWORD_MIN_LENGTH');
    expect(line).toContain('PASSWORD_MAX_CHARS');
    expect(line).not.toMatch(/\d/);
  });

  /**
   * SEC2-08：三个"已锁"出口都必须带 `retry-after`，不只是 `rejectLocked` 那两个。
   *
   * @why 第三条（`locked_while_verifying`：比对口令的 100ms 里被别的请求上了锁）曾经不设头，
   *      于是同一个 42901 有两种响应形状——而契约 0.6.20 写的是"锁定期 429 / 42901 + Retry-After"。
   *      它的触发需要并发（另一个请求在 bcrypt 期间把锁打上），做成真用例必然偶发红，
   *      所以这里守的是**分支里有没有这个头**，不假装测到了并发。
   * @why 2026-10-13（AJ-519）起，`42901` 这个码**不写在各分支里**了：同一个码有两种成因
   *      （被锁 / 同一来源抽水被限流），只有"被锁"那一种要对外带 `data.reason`，
   *      所以收成一个 `loginLocked()`（一处写对、三处用）。断言因此**跟着定义看**——
   *      只断言分支里有 `42901` 的话，把 `throw loginLocked()` 换成别的 throw 就假绿
   *      （下面 190 行那条对 `rejectLocked` 用的就是同一套做法）。守的东西没变：
   *      三处带 `retry-after`、且抛的是那个唯一的"已锁"错误。
   */
  /** 三个"已锁"出口共用的错误构造处（`const loginLocked = …;` 那两行）。 */
  const lockedErrorDefinition = (): string => {
    const code = codeLines.map((l) => l.text).join('\n');
    const at = code.indexOf('const loginLocked =');
    expect(at, '找不到 loginLocked 的定义（改名了？那要同步改本文件）').toBeGreaterThanOrEqual(0);
    return code.slice(at, code.indexOf(';', at));
  };

  it('🔴 三个"已锁"出口都带 retry-after：locked_while_verifying 分支也不例外（SEC2-08）', () => {
    const code = codeLines.map((l) => l.text).join('\n');
    const start = code.indexOf("if (clearedSource === 'locked' || clearedEmail === 'locked') {");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = code.indexOf('\n        }', start);
    const branch = code.slice(start, end === -1 ? code.length : end);
    expect(branch).toContain('retry-after');
    expect(branch).toContain('loginLocked(');
    expect(lockedErrorDefinition()).toContain('42901');
  });

  it('拿不到额度时不得再碰 bcrypt：locked 分支里只有 42901，没有一次口令比对', () => {
    const code = codeLines.map((l) => l.text).join('\n');
    // AJ-243：额度分两层（来源桶 + 邮箱桶），locked 分支是"任一层已锁"
    const start = code.indexOf("if (bySource.kind === 'locked' || byEmail.kind === 'locked') {");
    expect(start).toBeGreaterThanOrEqual(0);
    // 分支闭合 = 下一个"缩进 8 空格的 }"（分支体缩进 10 空格，函数体其余部分亦然但不会更早出现）
    const end = code.indexOf('\n        }', start);
    const branch = code.slice(start, end === -1 ? code.length : end);
    expect(branch).not.toContain('verifyPassword(');

    // ⚠️ 三个"已锁"出口已收敛成 `rejectLocked`（PAY3-04 起的 ⓪ 步还要复用它），
    //    42901 / retry-after 不在分支里了 —— **跟着定义看**，否则把 reject 换成别的就假绿。
    expect(branch).toContain('rejectLocked(');
    const hs = code.indexOf('const rejectLocked =');
    expect(hs).toBeGreaterThanOrEqual(0);
    const helper = code.slice(hs, code.indexOf('\n        };', hs));
    expect(helper).toContain('retry-after');
    expect(helper).not.toContain('verifyPassword(');
    // 错误本身收在 loginLocked() 里（AJ-519），helper 只负责"设头 + 抛它"；码与 reason 都在定义处钉住
    expect(helper).toContain('loginLocked(');
    const def = lockedErrorDefinition();
    expect(def).toContain('42901');
    expect(def).toContain('admin_account_locked');
  });
});
