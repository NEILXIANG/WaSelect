/**
 * 职责：`adapters/catalog-admin.ts`（管理端商品写仓储）的真库用例（I2 U-A2）。
 *
 * @why 写仓储必须钉在**真库**上：内存版能验证"我调用了什么"，验证不了
 *      "这条 SQL 在真库上会不会被 CHECK 约束拒"。products 表有两条硬约束
 *      （`origin_country='JP'`、`price_jpy>0`、`weight_g>0`），
 *      它们正是"管理端没拦住时最后一道防线"——只有真库能证明它还在。
 *
 * @why `updated_at` 断言用"不早于"而不是"等于"：时间由 SQL `now()` 产生（F10：
 *      业务侧不取时钟），断言相等会引入 flaky；断言"确实被推进了"才是要守的性质。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { makeProduct } from '../../../test/factories/entities.js';
import { createRng } from '../../../test/factories/rng.js';
import { createIds } from '../../../test/factories/entities.js';
import type { AdminProductInsert } from './catalog-admin.js';
import { createCatalogAdminRepo } from './catalog-admin.js';

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

/** 一条合法的管理端输入（与 domain/product-input 归一化后的形状一致）。 */
function input(overrides: Partial<AdminProductInsert> = {}): AdminProductInsert {
  return {
    id: 'p-1',
    title: '测试商品',
    category: 'beauty',
    description: null,
    images: [],
    price_jpy: 3600,
    cost_jpy: null,
    weight_g: 800,
    stock: 5,
    compliance_tags: [],
    hs_code: null,
    customs_desc_en: 'cosmetic set',
    origin_country: 'JP',
    title_ja: null,
    jan_code: null,
    purchase_source: null,
    status: 'active',
    ...overrides,
  };
}

/** ⚠️ 每次调用必须给不同的 `tag`：id 序列由 seed 决定，同 seed 会撞主键。 */
async function seedProducts(n: number, status = 'active', tag = 'a'): Promise<void> {
  const rng = createRng(`admin-catalog-${tag}`);
  const nextId = createIds(`admin-catalog-${tag}`);
  for (let i = 0; i < n; i += 1) {
    const p = makeProduct(rng, nextId, { status });
    await db`
      insert into products (id, title, category, description, images, price_jpy, cost_jpy,
                            weight_g, stock, compliance_tags, hs_code, customs_desc_en,
                            origin_country, title_ja, jan_code, purchase_source, status)
      values (${p.id}, ${p.title}, ${p.category}, ${p.description}, ${db.json(p.images as never)},
              ${p.price_jpy}, ${p.cost_jpy}, ${p.weight_g}, ${p.stock},
              ${db.json(p.compliance_tags as never)}, ${p.hs_code}, ${p.customs_desc_en},
              ${p.origin_country}, ${p.title_ja}, ${p.jan_code}, ${p.purchase_source}, ${p.status})
    `;
  }
}

describe('catalog-admin（管理端商品写仓储，I2 U-A2）', () => {
  const repo = () => createCatalogAdminRepo(testDb());

  it('insertProduct → 返回完整行，含服务端生成的 updated_at', async () => {
    const row = await repo().insertProduct(input());
    expect(row.id).toBe('p-1');
    expect(row.price_jpy).toBe(3600);
    expect(row.origin_country).toBe('JP');
    expect(row.status).toBe('active');
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('insertProduct：origin 非 JP → 真库 CHECK 拒绝（D-43 最后一道防线仍在）', async () => {
    await expect(repo().insertProduct(input({ origin_country: 'CN' }))).rejects.toThrow();
  });

  it('insertProduct：price_jpy = 0 → 真库 CHECK 拒绝', async () => {
    await expect(repo().insertProduct(input({ price_jpy: 0 }))).rejects.toThrow();
  });

  it('listAdminProducts：不传 status = 全部；传了只给该状态', async () => {
    await seedProducts(3, 'active', 'a');
    await seedProducts(2, 'offline', 'b');
    const all = await repo().listAdminProducts({ page: 1, size: 50 });
    expect(all.total).toBe(5);
    const active = await repo().listAdminProducts({ page: 1, size: 50, status: 'active' });
    expect(active.total).toBe(3);
    // ⚠️ 必须断言**返回行本身**的状态，不能只断言 total：
    //    只断言 total 时，"丢掉了 where 但 count 还在"这种实现会全绿——
    //    而运营看到的是行，他会看到下架商品混在上架列表里（本次缺陷注入实测出来的盲区）
    // ⚠️ 必须断言**返回行本身**（条数 + 每条状态），不能只断言 total、也不能用 filter 后再数：
    //    filter 后的计数在"丢掉 where"时依然成立，等于没断言（本次缺陷注入实测出来的盲区）
    expect(active.items).toHaveLength(3);
    expect(active.items.every((r) => r.status === 'active')).toBe(true);
    const offline = await repo().listAdminProducts({ page: 1, size: 50, status: 'offline' });
    expect(offline.total).toBe(2);
    expect(offline.items).toHaveLength(2);
    expect(offline.items.every((r) => r.status === 'offline')).toBe(true);
  });

  it('listAdminProducts：分页正确（第 2 页不与第 1 页重复，total 仍是全量）', async () => {
    await seedProducts(5, 'active', 'c');
    const p1 = await repo().listAdminProducts({ page: 1, size: 2 });
    const p2 = await repo().listAdminProducts({ page: 2, size: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(2);
    expect(p1.total).toBe(5);
    const ids1 = p1.items.map((r) => r.id);
    for (const r of p2.items) expect(ids1).not.toContain(r.id);
  });

  it('listAdminProducts：行含管理端专有列（cost_jpy / jan_code / purchase_source）', async () => {
    await repo().insertProduct(input({ cost_jpy: 2000, jan_code: '4901234567890' }));
    const list = await repo().listAdminProducts({ page: 1, size: 10 });
    expect(list.items[0]?.cost_jpy).toBe(2000);
    expect(list.items[0]?.jan_code).toBe('4901234567890');
  });

  it('updateProduct：改得到已填字段与可空字段（置 null 生效）', async () => {
    await repo().insertProduct(input({ cost_jpy: 2000, jan_code: '4901234567890' }));
    const before = (await repo().listAdminProducts({ page: 1, size: 1 })).items[0];
    expect(before).toBeDefined();
    await new Promise((r) => setTimeout(r, 5)); // 让 now() 至少推进一点
    const after = await repo().updateProduct('p-1', input({ title: '改名后', jan_code: null }));
    expect(after?.title).toBe('改名后');
    expect(after?.jan_code).toBeNull();
    expect(after?.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });

  it('updateProduct：id 不存在 → null（路由层据此 40401）', async () => {
    expect(await repo().updateProduct('no-such', input())).toBeNull();
  });

  it('setProductStatus：active ↔ offline 都能改；不存在 → false', async () => {
    await repo().insertProduct(input());
    expect(await repo().setProductStatus('p-1', 'offline')).toBe(true);
    expect((await repo().listAdminProducts({ page: 1, size: 1 })).items[0]?.status).toBe('offline');
    expect(await repo().setProductStatus('p-1', 'active')).toBe(true);
    expect(await repo().setProductStatus('no-such', 'offline')).toBe(false);
  });
});
