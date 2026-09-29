/**
 * 职责：daily 看门狗（B11 / AJ-196）的行为用例——**真库 + 真 SQL 的时间判定**。
 *
 * @why 用真库而不是假 `tx`：这个 job 的全部价值就在那条 SQL 的**时间判定**
 *      （`make_interval`、null 语义、"早于"还是"早于等于"）。用假的 `tx` 返回预设布尔值，
 *      测的就成了"JS 分支对不对"，而真正会写错的那一半（SQL）完全没被碰到
 *      ——典型的自证断言（§2 第 21 条）。
 * @why 用真实的 `'daily'` 行而不是造一个专用行：job 里查的就是这一行（常量），
 *      给它加一个"可注入行名"的旋钮只为测试服务，等于把"盯错了行"这个
 *      最严重的失效形态从代码里删掉（§2 第 49 条：只从真实调用点取证）。
 *      db 项目是 `fileParallelism: false`，串行跑，改这一行不会撞到别的文件；
 *      `afterAll` 会把行恢复成 seed 时的形态（`last_success_at` 为 null）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../adapters/db.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import type { LogFields } from '../logger.js';
import {
  DAILY_JOB_ROW_NAME,
  DAILY_STALL_HOURS,
  type JobContext,
  type JobLogger,
  type JobOutcome,
} from '../ports/scheduler.js';
import { createDailyHeartbeatWatchJob } from './daily-heartbeat-watch.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  // 恢复成迁移 seed 的形态：行在、last_success_at 为 null
  await db`
    insert into job_runs (name) values (${DAILY_JOB_ROW_NAME})
    on conflict (name) do update set last_success_at = null
  `;
  await closeDb(db);
});

/** 本轮 tick 的开始时刻（固定值，全部用例共用同一个基准）。 */
const NOW = new Date('2026-09-24T12:00:00.000Z');
const HOUR_MS = 3_600_000;

interface LogLine {
  level: string;
  event: string;
  reason?: unknown;
}

function recorder(): { lines: LogLine[]; log: JobLogger } {
  const lines: LogLine[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: LogFields): void => {
      const ctx = fields?.['ctx'] as { reason?: unknown } | undefined;
      lines.push({ level, event, reason: ctx?.['reason'] });
    };
  return {
    lines,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

/** `'missing'` = 把整行删掉，模拟"看门狗在盯一个不存在的行"。 */
async function runJob(opts: {
  lastSuccessAt: Date | null | 'missing';
  processStartedAt: Date;
}): Promise<{ outcome: JobOutcome; lines: LogLine[] }> {
  if (opts.lastSuccessAt === 'missing') {
    await db`delete from job_runs where name = ${DAILY_JOB_ROW_NAME}`;
  } else {
    await db`
      insert into job_runs (name) values (${DAILY_JOB_ROW_NAME})
      on conflict (name) do nothing
    `;
    await db`
      update job_runs set last_success_at = ${opts.lastSuccessAt}
       where name = ${DAILY_JOB_ROW_NAME}
    `;
  }
  const { lines, log } = recorder();
  const ctx: JobContext<Db> = { tx: db, emit: () => {}, startedAt: NOW, log };
  const outcome = await createDailyHeartbeatWatchJob({
    processStartedAt: opts.processStartedAt,
  }).run(ctx);
  return { outcome, lines };
}

/** 进程启动时刻：默认"刚起来 1 小时"。 */
const JUST_STARTED = new Date(NOW.getTime() - 1 * HOUR_MS);
const UP_LONG_AGO = new Date(NOW.getTime() - (DAILY_STALL_HOURS + 1) * HOUR_MS);

describe('daily 看门狗（B11 / AJ-196）', () => {
  it('健康：上次成功在阈值内 → 不报（processed 0，无 error 日志）', async () => {
    const { outcome, lines } = await runJob({
      lastSuccessAt: new Date(NOW.getTime() - 1 * HOUR_MS),
      processStartedAt: JUST_STARTED,
    });
    expect(outcome.processed).toBe(0);
    expect(lines).toEqual([]);
  });

  it('停滞：上次成功在 27 小时前 → 报 stale', async () => {
    const { outcome, lines } = await runJob({
      lastSuccessAt: new Date(NOW.getTime() - 27 * HOUR_MS),
      processStartedAt: JUST_STARTED,
    });
    expect(outcome.processed).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['level']).toBe('error');
    expect(lines[0]?.['event']).toBe('daily_heartbeat_stalled');
    expect(lines[0]?.['reason']).toBe('stale');
  });

  it('边界：正好 26 小时不算停滞（判据是"早于"，不是"早于等于"），26 小时零 1 分算', async () => {
    const exactly = await runJob({
      lastSuccessAt: new Date(NOW.getTime() - DAILY_STALL_HOURS * HOUR_MS),
      processStartedAt: JUST_STARTED,
    });
    expect(exactly.outcome.processed).toBe(0);
    expect(exactly.lines).toEqual([]);

    const over = await runJob({
      lastSuccessAt: new Date(NOW.getTime() - DAILY_STALL_HOURS * HOUR_MS - 60_000),
      processStartedAt: JUST_STARTED,
    });
    expect(over.outcome.processed).toBe(1);
  });

  it('从没跑过但进程刚起来 → 不报（宽限期，否则每次部署都误报）', async () => {
    const { outcome, lines } = await runJob({
      lastSuccessAt: null,
      processStartedAt: JUST_STARTED,
    });
    expect(outcome.processed).toBe(0);
    expect(lines).toEqual([]);
  });

  it('从没跑过且进程已起来超过宽限期 → 报 never_ran（cron 没配 / 40101 这类）', async () => {
    const { outcome, lines } = await runJob({
      lastSuccessAt: null,
      processStartedAt: UP_LONG_AGO,
    });
    expect(outcome.processed).toBe(1);
    expect(lines[0]?.['reason']).toBe('never_ran');
  });

  it('行不存在 → 报 row_missing（看门狗在盯一个不存在的行，必须响）', async () => {
    const { outcome, lines } = await runJob({
      lastSuccessAt: 'missing',
      processStartedAt: JUST_STARTED,
    });
    expect(outcome.processed).toBe(1);
    expect(lines[0]?.['reason']).toBe('row_missing');
  });
});
