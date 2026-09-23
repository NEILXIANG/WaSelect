/**
 * 职责：身份状态查询的真库测试（D25）。
 *
 * @why 这一层的失败模式是"查出来的值不对"：`token_ver` 读成字符串（`"2" !== 2`）、
 *      `blocked_at` 读成字符串导致 `!== null` 恒真、或者缓存把封禁状态永久记住。
 *      这三条都不在类型检查的视野里——TS 看到的都是 `unknown`（postgres.js 的行类型），
 *      只有真库跑一遍才能确认"改密之后旧 token 真的进不来"。
 *
 * @limitation 不覆盖"缓存跨进程"的场景（多实例各有一份缓存），那是设计上接受的取舍，
 *             记在 identity.ts 文件头的 @limitation 里。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { createIdentityCheck, withIdentityCache, type IdentityCheck } from './identity.js';
import { ensureTestDb, resetTestDb, testDb } from '../../test/db/test-db.js';

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
  await db`insert into users (id, openid) values ('u-1', 'o-1') on conflict (id) do nothing`;
});

describe('createIdentityCheck（真库）', () => {
  it('token_ver 读回来是 number（读成字符串会让版本比对永远不等）', async () => {
    await db`update users set token_ver = 3 where id = 'u-1'`;
    const record = await createIdentityCheck(db).load('u-1');
    expect(record?.tokenVer).toBe(3);
    expect(typeof record?.tokenVer).toBe('number');
  });

  it('未封禁时 blockedAt 是 null（读成字符串会让它恒为"已封禁"）', async () => {
    const record = await createIdentityCheck(db).load('u-1');
    expect(record?.blockedAt).toBeNull();
  });

  it('封禁后能读到时间', async () => {
    await db`update users set blocked_at = now() where id = 'u-1'`;
    const record = await createIdentityCheck(db).load('u-1');
    expect(record?.blockedAt).toBeInstanceOf(Date);
  });

  it('用户不存在 → null（不是抛错：调用方按"凭证失效"处理）', async () => {
    await expect(createIdentityCheck(db).load('u-nope')).resolves.toBeNull();
  });
});

describe('withIdentityCache', () => {
  /** 计数包装：验证"到底查了几次库"。 */
  function counting(inner: IdentityCheck): { check: IdentityCheck; calls: () => number } {
    let n = 0;
    return {
      check: {
        load: async (sub: string) => {
          n += 1;
          return inner.load(sub);
        },
      },
      calls: () => n,
    };
  }

  it('TTL 之内只查一次库（否则每个请求一次查询，JWT 的零 IO 优势被抵消）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 60_000);
    await cached.load('u-1');
    await cached.load('u-1');
    await cached.load('u-1');
    expect(inner.calls()).toBe(1);
  });

  it('TTL 过期后重新查（否则封禁永远不生效）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 50);
    await cached.load('u-1');
    // 期间把用户封掉：缓存过期后必须能看到新状态
    await db`update users set blocked_at = now() where id = 'u-1'`;
    await new Promise((r) => setTimeout(r, 80));
    const after = await cached.load('u-1');
    expect(inner.calls()).toBe(2);
    expect(after?.blockedAt).toBeInstanceOf(Date);
  });

  it('"查不到"也会被缓存（否则不存在的用户会变成放大攻击面）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 60_000);
    await cached.load('u-nope');
    await cached.load('u-nope');
    expect(inner.calls()).toBe(1);
  });
});
