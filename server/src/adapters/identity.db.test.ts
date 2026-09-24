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
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';

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

  it('is_admin 读回来是 boolean（N9：管理员撤权要回源校验，读漏了就是 12 小时越权窗口）', async () => {
    const before = await createIdentityCheck(db).load('u-1');
    expect(before?.isAdmin).toBe(false);
    await db`update users set is_admin = true where id = 'u-1'`;
    const after = await createIdentityCheck(db).load('u-1');
    expect(after?.isAdmin).toBe(true);
    expect(typeof after?.isAdmin).toBe('boolean');
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

  it('缓存超过上限时逐出最久未用条目（N29：无界 Map 是内存泄漏面，越权/封禁状态也会永久滞留）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 60_000, 2); // cap=2 便于验证
    await cached.load('u-1');
    await db`insert into users (id, openid) values ('u-2', 'o-2') on conflict (id) do nothing`;
    await db`insert into users (id, openid) values ('u-3', 'o-3') on conflict (id) do nothing`;
    await cached.load('u-2');
    await cached.load('u-3'); // 写入第 3 条：u-1 应被逐出
    expect(inner.calls()).toBe(3);
    await cached.load('u-1'); // 已被逐出 → 重新查库
    expect(inner.calls()).toBe(4);
    await cached.load('u-3'); // 仍在缓存 → 不查库
    expect(inner.calls()).toBe(4);
  });

  it('命中会刷新新旧（热点用户不该被逐出）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 60_000, 2);
    await cached.load('u-1');
    await db`insert into users (id, openid) values ('u-2', 'o-2') on conflict (id) do nothing`;
    await db`insert into users (id, openid) values ('u-3', 'o-3') on conflict (id) do nothing`;
    await cached.load('u-2');
    await cached.load('u-1'); // 命中刷新：u-1 变最新，u-2 变最旧
    await cached.load('u-3'); // 逐出的应是 u-2 而不是 u-1
    await cached.load('u-1');
    expect(inner.calls()).toBe(3); // u-1 没被逐出，没再查库
  });

  /**
   * @why Map 的 `set()` 对**已存在**的键只更新值、**不动插入位置**。
   *      于是"TTL 过期 → 重新查库 → 回写"这条路径若只 set 不 delete，刚花一次 IO 换来的
   *      条目会**停在它原来的位置**——只要它前面还有更旧的条目被逐出、它自己没被删，
   *      它就仍是"最旧候选"，下一轮插入优先把它带走：刚查完就白查。
   *      表现为**热点用户每次都 miss**（缓存对它完全失效），而缓存大小、TTL 看起来都正常。
   *
   * @limitation 这条用例必须先让 u-1 命中一次（把它挪到较新位置），再让**全部**条目过期，
   *      然后重查 u-1——否则过期路径正好会先逐出 u-1 自己（删后再插反而顺序是对的），
   *      缺陷不会显现。构造顺序本身就是这个 bug 的一部分，改动前请先读懂这段。
   */
  it('TTL 过期后重新查库也要刷新新旧（刚刷新的条目不该马上被逐出）', async () => {
    const inner = counting(createIdentityCheck(db));
    const cached = withIdentityCache(inner.check, 150, 3); // TTL 150ms、cap 3
    for (const id of ['u-1', 'u-2', 'u-3', 'u-4', 'u-5']) {
      await db`insert into users (id, openid) values (${id}, ${`o-${id}`}) on conflict (id) do nothing`;
    }
    await cached.load('u-1'); // [u-1]
    await cached.load('u-2'); // [u-1,u-2]
    await cached.load('u-1'); // 命中刷新 → [u-2,u-1]
    await cached.load('u-3'); // → [u-2,u-1,u-3]
    expect(inner.calls()).toBe(3);

    await new Promise((r) => setTimeout(r, 200)); // 全部过期
    await cached.load('u-1'); // 过期 → 重查；逐出最旧的 u-2 后回写，u-1 必须成为**最新**
    expect(inner.calls()).toBe(4);

    await cached.load('u-4'); // 未满，直接入 → 缺陷版 [u-1,u-3,u-4]，正确版 [u-3,u-1,u-4]
    await cached.load('u-5'); // 满了 → 逐出最旧：缺陷版逐出 u-1（刚刷新的），正确版逐出 u-3
    await cached.load('u-1'); // 正确版仍命中；缺陷版已被逐出 → 又查一次库
    expect(inner.calls()).toBe(6); // 缺陷版会是 7
  });
});
