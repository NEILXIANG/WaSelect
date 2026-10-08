/**
 * 职责：`user_events` **受控删除路径**的真库测试（AJ-413：180 天保留期清理 + APPI 按 user_id 删除）。
 *
 * @why 这张表挂 append-only 触发器（002），而隐私政策承诺"保存 180 天后删除 / 用户要求即删除"。
 *      两者并存的唯一方式是触发器留一道**窄口**：事务内 `SET LOCAL waselect.user_events_purge = 'on'`
 *      时才放行 DELETE（UPDATE 永远拒）。本文件验的就是这道口子的**四条边**：
 *      ① 不开口子 DELETE 仍被拒（002 的防线没被拆）；② 开了口子 UPDATE 仍被拒（口子只对删除有效）；
 *      ③ 口子只在**事务内**有效——拿连接池直连调用（没有事务）必须失败而不是静默删掉；
 *      ④ 事务提交后口子自动关闭（下一条普通 DELETE 又被拒）。
 * @why 保留期边界写成 179 / 180 / 181 天三行而不是"很久以前 / 刚才"：方向写反（`>` 写成 `<`）或
 *      少减一天都会在这三行上暴露，而"很久以前"对两种写法都绿。
 * @limitation 用 `created_at` 直插历史行（append 永远写"现在"），这是本文件唯一绕过写入方的地方。
 *
 * @see ./user-events.ts；migrations/036_user_events_purge_path.sql；docs/自主决策记录.md AJ-413
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTransaction, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  createUserEventsRepo,
  purgeExpiredUserEvents,
  purgeUserEventsByUser,
  USER_EVENTS_PURGE_BATCH,
  USER_EVENTS_RETENTION_DAYS,
  userEventsRetentionCutoff,
} from './user-events.js';

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

const DAY = 86_400_000;
const NOW = new Date('2026-10-09T03:00:00.000Z');

async function insertEvent(
  userId: string | null,
  ageDays: number,
  event = 'page_view',
): Promise<void> {
  await db`
    insert into user_events (user_id, session_id, event, props, created_at)
    values (${userId}, 'sess-1', ${event}, '{"page":"home"}'::jsonb, ${new Date(NOW.getTime() - ageDays * DAY)})
  `;
}

async function count(where: 'all' | { user: string }): Promise<number> {
  const rows =
    where === 'all'
      ? await db`select count(*)::int as n from user_events`
      : await db`select count(*)::int as n from user_events where user_id = ${where.user}`;
  return Number(rows[0]?.['n']);
}

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe('userEventsRetentionCutoff', () => {
  it('由给定时刻回退 180 天（不按天取整、不按 JST 截断）', () => {
    expect(USER_EVENTS_RETENTION_DAYS).toBe(180);
    expect(userEventsRetentionCutoff(new Date('2026-10-09T03:00:00.000Z')).toISOString()).toBe(
      '2026-04-12T03:00:00.000Z',
    );
  });
});

describe('purgeExpiredUserEvents（保留期清理）', () => {
  it('🔴 只删 created_at 早于 cutoff 的行：181 天前删、180 天整点不删、179 天前不删；匿名行同样适用', async () => {
    await insertEvent('u-1', 181);
    await insertEvent('u-1', 180);
    await insertEvent('u-1', 179);
    await insertEvent(null, 181);
    await insertEvent(null, 1);
    const cutoff = userEventsRetentionCutoff(NOW);
    const deleted = await withTransaction(db, (tx) => purgeExpiredUserEvents(tx, cutoff));
    expect(deleted).toBe(2);
    const left = await db`select user_id, created_at from user_events order by created_at`;
    expect(left.map((r) => r['created_at'])).toEqual([
      new Date(NOW.getTime() - 180 * DAY),
      new Date(NOW.getTime() - 179 * DAY),
      new Date(NOW.getTime() - 1 * DAY),
    ]);
  });

  it('一次最多删一个批次（USER_EVENTS_PURGE_BATCH），返回本批删除数；再调一次接着删', async () => {
    for (let i = 0; i < 7; i += 1) await insertEvent('u-1', 200 + i);
    const cutoff = userEventsRetentionCutoff(NOW);
    expect(USER_EVENTS_PURGE_BATCH).toBeGreaterThan(7);
    const first = await withTransaction(db, (tx) => purgeExpiredUserEvents(tx, cutoff, 3));
    expect(first).toBe(3);
    expect(await count('all')).toBe(4);
    const second = await withTransaction(db, (tx) => purgeExpiredUserEvents(tx, cutoff, 10));
    expect(second).toBe(4);
    expect(await count('all')).toBe(0);
  });

  it('没有过期行 → 0（无事可做，不是失败）', async () => {
    await insertEvent('u-1', 3);
    expect(
      await withTransaction(db, (tx) => purgeExpiredUserEvents(tx, userEventsRetentionCutoff(NOW))),
    ).toBe(0);
    expect(await count('all')).toBe(1);
  });
});

describe('purgeUserEventsByUser（APPI 按 user_id 删除）', () => {
  it('🔴 只删该用户的行（不论多旧）；别人的与匿名的一条不动', async () => {
    await insertEvent('u-del', 1);
    await insertEvent('u-del', 400, 'add_to_cart');
    await insertEvent('u-keep', 1);
    await insertEvent(null, 1);
    const deleted = await withTransaction(db, (tx) => purgeUserEventsByUser(tx, 'u-del'));
    expect(deleted).toBe(2);
    expect(await count({ user: 'u-del' })).toBe(0);
    expect(await count({ user: 'u-keep' })).toBe(1);
    expect(await count('all')).toBe(2);
  });

  it('该用户没有记录 → 0', async () => {
    expect(await withTransaction(db, (tx) => purgeUserEventsByUser(tx, 'u-none'))).toBe(0);
  });
});

describe('窄口豁免的四条边（002 的 append-only 防线没被拆）', () => {
  it('🔴 ① 普通 DELETE 仍被拒（42501，"只允许 INSERT"）', async () => {
    await insertEvent('u-1', 300);
    await expect(db`delete from user_events where user_id = 'u-1'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    expect(await sqlState(db`delete from user_events`)).toBe('42501');
    expect(await count('all')).toBe(1);
  });

  it('🔴 ② 开了口子 UPDATE 仍被拒：口子只对 DELETE 有效', async () => {
    await insertEvent('u-1', 300);
    const state = await sqlState(
      withTransaction(db, async (tx) => {
        await tx`set local waselect.user_events_purge = 'on'`;
        await tx`update user_events set user_id = 'tampered' where user_id = 'u-1'`;
      }),
    );
    expect(state).toBe('42501');
    expect(await count({ user: 'u-1' })).toBe(1);
  });

  it('🔴 ③ 不在事务里调用 → 失败（42501）而不是静默删掉：SET LOCAL 在事务外无效，口子开不了', async () => {
    await insertEvent('u-1', 300);
    // @measured（2026-10-09，PG 16.15 / postgres.js）：池连接上先 `set local`（WARNING，无效）再 delete → 42501
    expect(await sqlState(purgeUserEventsByUser(db, 'u-1'))).toBe('42501');
    expect(await sqlState(purgeExpiredUserEvents(db, userEventsRetentionCutoff(NOW)))).toBe(
      '42501',
    );
    expect(await count('all')).toBe(1);
  });

  it('🔴 ⑤ 口子只在删除函数内部开着：同一事务里紧接着的普通 DELETE 又被拒（daily 后面的 job 拿不到口子）', async () => {
    await insertEvent('u-1', 300);
    await insertEvent('u-2', 300);
    const state = await sqlState(
      withTransaction(db, async (tx) => {
        await purgeUserEventsByUser(tx, 'u-1');
        await tx`delete from user_events where user_id = 'u-2'`;
      }),
    );
    expect(state).toBe('42501');
    expect(await count('all')).toBe(2);
  });

  it('🔴 ④ 事务提交后口子自动关闭：同一个池上紧接着的普通 DELETE 又被拒', async () => {
    await insertEvent('u-1', 300);
    await insertEvent('u-2', 300);
    await withTransaction(db, (tx) => purgeUserEventsByUser(tx, 'u-1'));
    await expect(db`delete from user_events where user_id = 'u-2'`).rejects.toThrow(
      /只允许 INSERT/,
    );
    expect(await count({ user: 'u-2' })).toBe(1);
  });

  it('删除失败时整个事务回滚（删到一半不会留下"只删了一部分"）', async () => {
    await insertEvent('u-1', 300);
    await insertEvent('u-1', 301);
    const state = await sqlState(
      withTransaction(db, async (tx) => {
        await purgeUserEventsByUser(tx, 'u-1');
        throw Object.assign(new Error('sentinel'), { code: 'SENTINEL' });
      }),
    );
    expect(state).toBe('SENTINEL');
    expect(await count({ user: 'u-1' })).toBe(2);
  });
});

describe('createUserEventsRepo：写入方的两条边（覆盖率门槛 100% 不许留"没人调过"的分支）', () => {
  it('append 空批次 → 不发 INSERT、表里零行；existingOrderIds / existingProductIds 空入参 → 空集', async () => {
    const repo = createUserEventsRepo(db);
    await repo.append({ userId: null, sessionId: 's', traceId: null, reqId: null }, []);
    expect(await count('all')).toBe(0);
    expect(await repo.existingOrderIds([])).toEqual(new Set());
    expect(await repo.existingProductIds([])).toEqual(new Set());
  });

  it('existingOrderIds 只回真实存在的订单 id（不看归属）', async () => {
    await db`insert into users (id, openid) values ('u-ev', 'o-ev')`;
    await db`insert into orders (id, order_no, user_id, status, items_jpy, total_jpy, fx_snapshot, address_snapshot, terms_version, expires_at)
             values ('o-ev-1', '261009-EVAAAA', 'u-ev', 'created', 100, 100, '{}', '{}', 'TOS', now())`;
    const repo = createUserEventsRepo(db);
    expect(await repo.existingOrderIds(['o-ev-1', 'o-nope'])).toEqual(new Set(['o-ev-1']));
  });
});
