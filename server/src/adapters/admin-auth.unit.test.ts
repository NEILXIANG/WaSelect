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
import {
  loginAttemptKey,
  loginAttemptsCutoff,
  LOGIN_ATTEMPT_RETENTION_HOURS,
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

describe('loginAttemptsCutoff', () => {
  it(`基准时刻往前 ${LOGIN_ATTEMPT_RETENTION_HOURS} 小时（F10：由传入的时钟推导，不自己取 now）`, () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(loginAttemptsCutoff(now).toISOString()).toBe('2026-09-28T12:00:00.000Z');
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
    expect(helper).toContain('42901');
    expect(helper).toContain('retry-after');
    expect(helper).not.toContain('verifyPassword(');
  });
});
