/**
 * 职责：商品分类仓储（categories.ts）的真实 Postgres 集成测试（AJ-491）。
 *
 * @why product_categories 是"保留种子"的字典表（resetTestDb 不清它，预置四类由迁移 039 写入）：
 *      本文件只增删 `probe_` 开头的键，用例前后都清掉自己写的行，不碰四个预置分类（CLAUDE.md 约束二：只删自己写的行）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  categoryExists,
  createCategory,
  deleteCategory,
  listAdminCategories,
  listVisibleCategories,
  updateCategory,
} from './categories.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

const cleanProbes = async (): Promise<void> => {
  await db`delete from products where category like 'probe\\_%'`;
  await db`delete from product_categories where key like 'probe\\_%'`;
};

beforeEach(async () => {
  await resetTestDb(db);
  await cleanProbes();
});
afterEach(cleanProbes);

async function product(id: string, category: string, status = 'active'): Promise<void> {
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country, status)
    values (${id}, ${`商品 ${id}`}, ${category}, 1000, 100, 'JP', ${status})
  `;
}

describe('预置分类（迁移 039）', () => {
  it('四个原分类在表里，键与中文名不变，按 10 / 20 / 30 / 40 排序', async () => {
    const all = await listAdminCategories(db);
    expect(
      all.filter((c) => !c.key.startsWith('probe_')).map((c) => [c.key, c.name, c.sort]),
    ).toEqual([
      ['beauty', '美妆护肤', 10],
      ['daily', '生活百货', 20],
      ['kitchen', '厨房餐具', 30],
      ['food', '食品', 40],
    ]);
  });
});

describe('买家端可见分类 listVisibleCategories', () => {
  it('🔴 只出"启用且至少有一件在售商品"的分类，按排序；草稿 / 下架商品不算，售罄（在售、库存 0）仍算', async () => {
    await createCategory(db, { key: 'probe_tea', name: '茶叶', sort: 5 });
    await createCategory(db, { key: 'probe_toy', name: '玩具', sort: 6 });
    await createCategory(db, { key: 'probe_off', name: '停用类', sort: 7 });
    await updateCategory(db, 'probe_off', { active: false });
    await product('p-tea', 'probe_tea'); // 在售 → 显示
    await product('p-toy', 'probe_toy', 'draft'); // 只有草稿 → 不显示
    await product('p-off', 'probe_off'); // 分类停用 → 不显示
    await product('p-food', 'food');
    const v = await listVisibleCategories(db);
    expect(v.map((c) => c.key)).toEqual(['probe_tea', 'food']);
    expect(v[0]).toEqual({ key: 'probe_tea', name: '茶叶' });
  });
});

describe('后台管理', () => {
  it('🔴 列表带在售 / 全部商品数；新建、改名改序、停用', async () => {
    await createCategory(db, { key: 'probe_tea', name: '茶叶', sort: 5 });
    await product('p1', 'probe_tea');
    await product('p2', 'probe_tea', 'draft');
    let row = (await listAdminCategories(db)).find((c) => c.key === 'probe_tea');
    expect(row).toMatchObject({
      name: '茶叶',
      sort: 5,
      active: true,
      active_product_count: 1,
      product_count: 2,
    });
    const upd = await updateCategory(db, 'probe_tea', { name: '日本茶', sort: 50, active: false });
    expect(upd).toMatchObject({ key: 'probe_tea', name: '日本茶', sort: 50, active: false });
    row = (await listAdminCategories(db)).find((c) => c.key === 'probe_tea');
    expect(row?.name).toBe('日本茶');
    expect(await updateCategory(db, 'probe_nope', { name: 'x' })).toBeNull();
    expect(await categoryExists(db, 'probe_tea')).toBe(true);
    expect(await categoryExists(db, 'probe_nope')).toBe(false);
  });

  it('🔴 键或名称重复 → duplicate（指明是哪一项），不抛 23505', async () => {
    await createCategory(db, { key: 'probe_tea', name: '茶叶', sort: 5 });
    expect(await createCategory(db, { key: 'probe_tea', name: '别的', sort: 5 })).toEqual({
      ok: false,
      field: 'key',
    });
    expect(await createCategory(db, { key: 'probe_tea2', name: '茶叶', sort: 5 })).toEqual({
      ok: false,
      field: 'name',
    });
    expect(await updateCategory(db, 'probe_tea2', { name: '茶叶' })).toBeNull();
    await createCategory(db, { key: 'probe_tea2', name: '茶具', sort: 6 });
    expect(await updateCategory(db, 'probe_tea2', { name: '茶叶' })).toEqual({
      ok: false,
      field: 'name',
    });
  });

  it('🔴 删除：没有商品 → deleted；还有商品（含草稿）→ in_use，不删；不存在 → not_found', async () => {
    await createCategory(db, { key: 'probe_a', name: '甲类', sort: 1 });
    await createCategory(db, { key: 'probe_b', name: '乙类', sort: 2 });
    await product('pb', 'probe_b', 'draft');
    expect(await deleteCategory(db, 'probe_a')).toBe('deleted');
    expect(await deleteCategory(db, 'probe_b')).toBe('in_use');
    expect(await categoryExists(db, 'probe_b')).toBe(true);
    expect(await deleteCategory(db, 'probe_zz')).toBe('not_found');
  });
});
