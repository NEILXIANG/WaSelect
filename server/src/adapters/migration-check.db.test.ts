/**
 * 启动期迁移齐全校验（第三轮缺口 P1-2）。
 * @why 本机实测：库停在 028 而代码已写 029 的列，服务照常启动、/healthz /readyz 全绿，所有建单 500。
 *      生产里迁移失败 / 被跳过 / 只回滚了代码时是同一个形态，而外部探活看不出来。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import { checkMigrations, readMigrationNames } from './migration-check.js';

let db: Db;
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await closeDb(db);
});

describe('checkMigrations', () => {
  it('目录里的迁移全部已执行 → missing 为空', async () => {
    const names = readMigrationNames(DIR);
    expect(names.length).toBeGreaterThan(25);
    expect(names[0]).toMatch(/^001_/);
    const r = await checkMigrations(db, names);
    expect(r.missing).toEqual([]);
  });

  it('🔴 代码带了一个库里没跑过的迁移 → missing 里点名它', async () => {
    const names = [...readMigrationNames(DIR), '999_not_applied_yet'];
    const r = await checkMigrations(db, names);
    expect(r.missing).toEqual(['999_not_applied_yet']);
  });

  it('库比代码新（只回滚了代码）→ ahead 列出，missing 仍为空', async () => {
    const names = readMigrationNames(DIR).slice(0, -1);
    const r = await checkMigrations(db, names);
    expect(r.missing).toEqual([]);
    expect(r.ahead).toHaveLength(1);
  });
});
