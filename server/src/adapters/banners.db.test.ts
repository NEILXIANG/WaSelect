/**
 * 职责：`adapters/banners.ts`（买家侧"此刻生效"读）的真库用例。
 *
 * @why 时间窗的四条边界必须**逐条**钉住（未开始 / 已过期 / 恰好开始 / 恰好结束）：
 *      banner 的失效形态是"静默不显示"——没有报错、没有日志，运营只看到
 *      "我配了，首页没有"。四条边界里只要有一条判反，就有一类配置永远上不了线，
 *      而排查时没人会先怀疑"是不是差了一秒"。
 *
 * @why 写入走**管理端**仓储（`banners-admin.ts`）而不是自己拼 insert SQL：
 *      生产就是这条路径（运营在后台保存 → 买家侧读）。用例里另写一份 insert，
 *      验的就不是"两个仓储对同一张表的读写是否一致"，而是"我这份 SQL 对不对"——
 *      而后者对生产没有任何证明力（AJ-29：断言要落在事实上）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createBannersRepo } from './banners.js';
import { createBannersAdminRepo, type BannerWrite } from './banners-admin.js';

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

const PAST = Date.parse('2026-10-01T00:00:00Z');
const NOW_MS = Date.parse('2026-10-05T00:00:00Z');
const FUTURE = Date.parse('2026-10-09T00:00:00Z');
const NOW = new Date(NOW_MS);

/** 一条"此刻应当生效"的配置（起止把 NOW 包在中间）。 */
const W: BannerWrite = {
  imageKey: 'banners/2026/a.png',
  linkType: 'product',
  linkId: 'p-1',
  sort: 3,
  active: true,
  startsAtMs: PAST,
  endsAtMs: FUTURE,
};

describe('listActiveBanners', () => {
  it('空表 → []', async () => {
    expect(await createBannersRepo(db).listActiveBanners(NOW)).toEqual([]);
  });

  it('停用的不返回（管理端仍看得见它：停用 ≠ 删除）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-on', active: true });
    await write.insertBanner({ ...W, id: 'b-off', active: false });
    expect((await createBannersRepo(db).listActiveBanners(NOW)).map((r) => r.id)).toEqual(['b-on']);
    // 对偶：管理端**两份都要**看见，否则运营找不回它来重新启用
    expect((await write.listBanners()).map((r) => r.id)).toEqual(['b-on', 'b-off']);
  });

  it('未开始的（starts_at 在未来）不返回', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-later', startsAtMs: NOW_MS + 1000 });
    expect(await createBannersRepo(db).listActiveBanners(NOW)).toEqual([]);
  });

  it('已过期的（ends_at 在过去）不返回', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-over', endsAtMs: NOW_MS - 1000 });
    expect(await createBannersRepo(db).listActiveBanners(NOW)).toEqual([]);
  });

  it('边界：now **恰好等于** starts_at / ends_at → 都算生效（两端闭区间，同一条口径）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-at-start', startsAtMs: NOW_MS });
    await write.insertBanner({ ...W, id: 'b-at-end', endsAtMs: NOW_MS });
    expect((await createBannersRepo(db).listActiveBanners(NOW)).map((r) => r.id)).toEqual([
      'b-at-start',
      'b-at-end',
    ]);
  });

  it('starts_at / ends_at 为 NULL = 该侧**不限制**（不是"永不生效"）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-no-start', startsAtMs: null });
    await write.insertBanner({ ...W, id: 'b-no-end', endsAtMs: null });
    await write.insertBanner({ ...W, id: 'b-open', startsAtMs: null, endsAtMs: null });
    expect((await createBannersRepo(db).listActiveBanners(NOW)).map((r) => r.id)).toEqual([
      'b-no-start',
      'b-no-end',
      'b-open',
    ]);
  });

  it('排序：sort 升序，同 sort 按创建时间升序', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-late', sort: 5 });
    await write.insertBanner({ ...W, id: 'b-early', sort: 1 });
    await write.insertBanner({ ...W, id: 'b-tie', sort: 1 });
    expect((await createBannersRepo(db).listActiveBanners(NOW)).map((r) => r.id)).toEqual([
      'b-early',
      'b-tie',
      'b-late',
    ]);
  });

  it('读出的字段与管理端写入的一致（两侧共用同一份行类型与读列清单）', async () => {
    const write = createBannersAdminRepo(db);
    await write.insertBanner({ ...W, id: 'b-1' });
    const [row] = await createBannersRepo(db).listActiveBanners(NOW);
    expect(row).toMatchObject({
      id: 'b-1',
      image_key: 'banners/2026/a.png',
      link_type: 'product',
      link_id: 'p-1',
      sort: 3,
      active: true,
    });
    expect(row?.starts_at?.toISOString()).toBe(new Date(PAST).toISOString());
    expect(row?.ends_at?.toISOString()).toBe(new Date(FUTURE).toISOString());
  });
});
