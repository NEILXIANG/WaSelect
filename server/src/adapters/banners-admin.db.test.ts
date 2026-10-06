/**
 * 职责：`adapters/banners-admin.ts` 的真库用例（I2 U-D2）。
 *
 * @why 断言一律查**库**：响应是路由自己拼的，库才是事实（§2 第 21 条）。
 *      Banner 的失效形态是"静默不显示"，保存后不查库根本看不出存成了什么。
 *
 * @why `updateBanner` 必须验"**只改了这一行**"：整行覆盖的 SQL 一旦 where 条件写漏
 *      （比如漏了 `where id = `），一次编辑会把**全部** banner 改成同一条——
 *      而响应仍然返回一行，看起来完全正常。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
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

const T0 = Date.parse('2026-10-01T00:00:00Z');
const T1 = Date.parse('2026-10-02T00:00:00Z');

const W: BannerWrite = {
  imageKey: 'banners/2026/a.png',
  linkType: 'product',
  linkId: 'p-1',
  sort: 3,
  active: true,
  startsAtMs: T0,
  endsAtMs: T1,
};

describe('listBanners', () => {
  it('空表 → []', async () => {
    expect(await createBannersAdminRepo(db).listBanners()).toEqual([]);
  });

  it('含停用与未开始的（管理端要能看见它们，否则"停用"= 永久删除视图）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    await repo.insertBanner({ ...W, id: 'b-2', active: false });
    await repo.insertBanner({ ...W, id: 'b-3', startsAtMs: Date.parse('2099-01-01T00:00:00Z') });
    expect((await repo.listBanners()).map((r) => r.id)).toEqual(['b-1', 'b-2', 'b-3']);
  });

  it('排序：sort 升序，同 sort 按创建时间升序（@limitation 三：sort 重复不是错误）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-late', sort: 5 });
    await repo.insertBanner({ ...W, id: 'b-early', sort: 1 });
    await repo.insertBanner({ ...W, id: 'b-tie', sort: 1 });
    expect((await repo.listBanners()).map((r) => r.id)).toEqual(['b-early', 'b-tie', 'b-late']);
  });
});

describe('insertBanner / findBanner', () => {
  it('字段往返一致；时间按 UTC 毫秒落库；link_id 可为 null', async () => {
    const repo = createBannersAdminRepo(db);
    const row = await repo.insertBanner({ ...W, id: 'b-1' });
    expect(row.id).toBe('b-1');
    expect(row.image_key).toBe('banners/2026/a.png');
    expect(row.link_type).toBe('product');
    expect(row.link_id).toBe('p-1');
    expect(row.sort).toBe(3);
    expect(row.active).toBe(true);
    expect(row.starts_at?.getTime()).toBe(T0);
    expect(row.ends_at?.getTime()).toBe(T1);

    const found = await repo.findBanner('b-1');
    expect(found?.image_key).toBe('banners/2026/a.png');

    const noLink = await repo.insertBanner({ ...W, id: 'b-2', linkType: 'none', linkId: null });
    expect(noLink.link_id).toBeNull();
    // 时间可空（"不限时间"是合法配置）
    const noTime = await repo.insertBanner({ ...W, id: 'b-3', startsAtMs: null, endsAtMs: null });
    expect(noTime.starts_at).toBeNull();
    expect(noTime.ends_at).toBeNull();
  });

  it('findBanner 查不到 → null（不抛，路由层据此判 404）', async () => {
    expect(await createBannersAdminRepo(db).findBanner('nope')).toBeNull();
  });
});

/** 这条 Banner 此刻的版本凭据（乐观锁，S-09）。 */
async function versionOf(id: string): Promise<string> {
  const [r] = await db`select updated_at from banners where id = ${id}`;
  return (r?.['updated_at'] as Date).toISOString();
}

/** 断言是改好的行（不是 'missing' / 'stale'）。 */
function asRow<T>(v: T | 'missing' | 'stale'): T {
  if (v === 'missing' || v === 'stale') throw new Error(`期望改好的行，实际 ${v}`);
  return v;
}

describe('updateBanner', () => {
  it('整行覆盖：所有字段都按传入值改（含"改回 null"）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    const out = asRow(
      await repo.updateBanner(
        'b-1',
        {
          imageKey: 'banners/2026/b.png',
          linkType: 'none',
          linkId: null, // ← 从 'p-1' 改成 null，验证不是"只改非空字段"
          sort: 9,
          active: false,
          startsAtMs: null,
          endsAtMs: null,
        },
        await versionOf('b-1'),
      ),
    );
    expect(out?.image_key).toBe('banners/2026/b.png');
    expect(out?.link_type).toBe('none');
    expect(out?.link_id).toBeNull();
    expect(out?.sort).toBe(9);
    expect(out?.active).toBe(false);
    expect(out?.starts_at).toBeNull();
    expect(out?.ends_at).toBeNull();
  });

  it('🔴 只改这一行：另一条 banner 一张没动（防 where 条件写漏 = 全表覆盖）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    await repo.insertBanner({ ...W, id: 'b-2', imageKey: 'other.png', sort: 7 });
    await repo.updateBanner('b-1', { ...W, imageKey: 'changed.png' }, await versionOf('b-1'));
    const all = await repo.listBanners();
    expect(all).toHaveLength(2);
    const other = all.find((r) => r.id === 'b-2');
    expect(other?.image_key).toBe('other.png');
    expect(other?.sort).toBe(7);
  });

  it('updated_at 由 SQL now() 刷新（不靠调用方传：业务侧不取时钟，F10）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    // 先把 updated_at 钉到一天前：间隔足够大，"没刷新"与"刷新了"不可能相等
    await db`update banners set updated_at = now() - interval '1 day' where id = ${'b-1'}`;
    const before = await repo.findBanner('b-1');
    const after = asRow(await repo.updateBanner('b-1', W, await versionOf('b-1')));
    expect(after.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? 0);
  });

  it('id 不存在 → missing（由路由转 404，绝不能当成"改成功了"）', async () => {
    expect(
      await createBannersAdminRepo(db).updateBanner('nope', W, '2026-10-01T00:00:00.000Z'),
    ).toBe('missing');
  });

  it('🔴 版本凭据对不上（打开之后被别人改过）→ stale，且不写（S-09）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    const stale = '2000-01-01T00:00:00.000Z';
    expect(await repo.updateBanner('b-1', { ...W, sort: 99 }, stale)).toBe('stale');
    expect((await repo.findBanner('b-1'))?.sort).toBe(W.sort);
  });
});

describe('deleteBanner', () => {
  it('存在 → true 且真没了吗（查库，不看返回值）', async () => {
    const repo = createBannersAdminRepo(db);
    await repo.insertBanner({ ...W, id: 'b-1' });
    expect(await repo.deleteBanner('b-1')).toBe(true);
    expect(await repo.listBanners()).toEqual([]);
  });

  it('不存在 → false（幂等：重复删除不报错，@limitation 二）', async () => {
    const repo = createBannersAdminRepo(db);
    expect(await repo.deleteBanner('nope')).toBe(false);
    await repo.insertBanner({ ...W, id: 'b-1' });
    expect(await repo.deleteBanner('b-1')).toBe(true);
    expect(await repo.deleteBanner('b-1')).toBe(false);
  });
});
