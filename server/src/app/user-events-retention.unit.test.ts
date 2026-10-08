/**
 * 职责：`user-events-retention.ts`（行为流 180 天保留期清理 job）的单测——只验**编排**：
 *       cutoff 取自 `ctx.startedAt − 180 天`、分批循环的停止条件、processed = 总删除数、日志一条。
 *
 * @why SQL 本身（边界、窄口豁免）由 `adapters/user-events.db.test.ts` 守；这里用假 tx 只盯 job：
 *      ① 批次满了要接着删、不满就停；② 批次数到上限要停（不把一次大积压放进同一个事务里跑到天亮）；
 *      ③ `capped` 要如实上报——"今天没删完"必须看得见，否则积压会被每天的 ok 日志盖住。
 * @limitation 假 tx 不执行 `set local`，只按语句顺序回放结果；它不能证明口子真的开了——那是 db 用例的事。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../adapters/db.js';
import { USER_EVENTS_PURGE_BATCH } from '../adapters/user-events.js';
import {
  createUserEventsRetentionJob,
  USER_EVENTS_RETENTION_JOB,
  USER_EVENTS_RETENTION_MAX_BATCHES,
} from './user-events-retention.js';

/** 按调用顺序回放各 DELETE 的返回行数；`set local` 这类无结果语句回空数组。 */
function fakeTx(deleteCounts: number[]) {
  const seen: { sql: string; values: unknown[] }[] = [];
  let i = 0;
  const tx = ((s: TemplateStringsArray, ...values: unknown[]) => {
    const sql = s.join('?');
    seen.push({ sql, values });
    if (!/delete from user_events/.test(sql)) return Promise.resolve([]);
    const n = deleteCounts[i] ?? 0;
    i += 1;
    return Promise.resolve(Array.from({ length: n }, (_, k) => ({ id: k })));
  }) as unknown as Db;
  return { tx, seen, deletes: () => seen.filter((x) => /delete from user_events/.test(x.sql)) };
}

function logSink() {
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const log = {
    info: (msg: string, fields: Record<string, unknown>) => logs.push({ msg, fields }),
    warn: (msg: string, fields: Record<string, unknown>) => logs.push({ msg, fields }),
    error: () => undefined,
  };
  return { logs, log: log as never };
}

const STARTED = new Date('2026-10-09T03:00:00.000Z');
const CUTOFF = '2026-04-12T03:00:00.000Z';

describe('createUserEventsRetentionJob', () => {
  it('cutoff = 开始时刻 − 180 天；一批没删满就停；processed = 删除数；落一条 user_events_retention 日志', async () => {
    const { tx, deletes } = fakeTx([3]);
    const { logs, log } = logSink();
    const job = createUserEventsRetentionJob();
    expect(job.name).toBe(USER_EVENTS_RETENTION_JOB);
    const out = await job.run({ tx, emit: () => undefined, startedAt: STARTED, log });
    expect(out).toEqual({ processed: 3 });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]?.values[0]).toEqual(new Date(CUTOFF));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe('user_events_retention');
    expect(logs[0]?.fields).toMatchObject({
      result: 'ok',
      count: 3,
      ctx: { retention_days: 180, cutoff: CUTOFF, batches: 1, capped: false },
    });
  });

  it('🔴 一批删满（= USER_EVENTS_PURGE_BATCH）就接着删下一批，直到不满为止；processed 是总数', async () => {
    const B = USER_EVENTS_PURGE_BATCH;
    const { tx, seen, deletes } = fakeTx([B, B, 7]);
    const { logs, log } = logSink();
    const out = await createUserEventsRetentionJob().run({
      tx,
      emit: () => undefined,
      startedAt: STARTED,
      log,
    });
    expect(out).toEqual({ processed: B * 2 + 7 });
    expect(deletes()).toHaveLength(3);
    // 口子成对开关：每批 on → delete → off（最后一条语句是 off，不把口子留给同事务后面的 job）
    const gates = seen
      .filter((x) => /set local waselect\.user_events_purge/.test(x.sql))
      .map((x) => x.sql);
    expect(gates.filter((g) => g.includes("'on'"))).toHaveLength(3);
    expect(gates.filter((g) => g.includes("'off'"))).toHaveLength(3);
    expect(/'off'/.test(seen.at(-1)?.sql ?? '')).toBe(true);
    expect(logs[0]?.fields).toMatchObject({ ctx: { batches: 3, capped: false } });
  });

  it('🔴 批次数到上限就停，并如实上报 capped=true（积压留到明天，不在一个事务里跑到天亮）', async () => {
    const B = USER_EVENTS_PURGE_BATCH;
    const { tx, deletes } = fakeTx(
      Array.from({ length: USER_EVENTS_RETENTION_MAX_BATCHES + 5 }, () => B),
    );
    const { logs, log } = logSink();
    const out = await createUserEventsRetentionJob().run({
      tx,
      emit: () => undefined,
      startedAt: STARTED,
      log,
    });
    expect(deletes()).toHaveLength(USER_EVENTS_RETENTION_MAX_BATCHES);
    expect(out).toEqual({ processed: B * USER_EVENTS_RETENTION_MAX_BATCHES });
    expect(logs[0]?.fields).toMatchObject({
      result: 'ok',
      ctx: { batches: USER_EVENTS_RETENTION_MAX_BATCHES, capped: true },
    });
  });

  it('没有过期行 → processed 0（正常，不是失败）', async () => {
    const { tx } = fakeTx([0]);
    const { log } = logSink();
    const out = await createUserEventsRetentionJob().run({
      tx,
      emit: () => undefined,
      startedAt: STARTED,
      log,
    });
    expect(out).toEqual({ processed: 0 });
  });
});
