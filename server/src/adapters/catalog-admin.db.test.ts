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
import { decrementStock, incrementStock } from './orders.js';
import { makeProduct } from '../../../test/factories/entities.js';
import { createRng } from '../../../test/factories/rng.js';
import { createIds } from '../../../test/factories/entities.js';
import type { AdminProductInsert, AdminProductUpdate } from './catalog-admin.js';
import { createCatalogAdminRepo } from './catalog-admin.js';

let db: Db;

/** 让 SQL `now()` 跨过至少一个毫秒（乐观锁按毫秒截断，同毫秒内的两次更新无法区分）。 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    why: null,
    maker: null,
    tags: [],
    ...overrides,
  };
}

/**
 * 一条合法的**更新**输入：`expectedUpdatedAt` 是乐观锁凭据（ADM3-02）。
 * @why 不复用 `input()` 再在外面补一个字段：`updateProduct` 现在是**判别联合**入参，
 *      缺了 `expectedUpdatedAt` 编译不过——但"编译不过"只保证类型对，不保证语义对；
 *      独立造一个是为了让"凭据取哪一行"在每个用例里都看得见。
 */
function updateInput(
  expectedUpdatedAt: string,
  overrides: Partial<AdminProductUpdate> = {},
): AdminProductUpdate {
  const { status, ...rest } = input();
  void status; // PUT 不碰上下架（AJ-175）：这里只是把它从"整行"里摘掉
  return { ...rest, expectedUpdatedAt, ...overrides };
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

  // ── DB3-02：排序键不得被库存变动刷新（也是 ADM3-02 乐观锁能成立的前提）──────────
  it('⚠️ 翻页期间有商品被下单扣库存 → 两页合起来仍然不漏不重', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await repo().insertProduct(input({ id: `p-page-${String(i)}`, stock: 10 }));
      ids.push(row.id);
      await sleep(10); // 三行要有严格递减的 updated_at，排序才有确定意义
    }
    const p1 = await repo().listAdminProducts({ page: 1, size: 2 });
    // 看第 1 页期间，第 3 名的商品被买走一件（它原本在第 2 页）
    const last = p1.items[p1.items.length - 1];
    expect(last).toBeDefined();
    const victim = ids.find((x) => !p1.items.some((r) => r.id === x));
    expect(victim).toBeDefined();
    expect(await decrementStock(db, String(victim), 1)).toBe(true);
    const p2 = await repo().listAdminProducts({ page: 2, size: 2 });

    // ⚠️ 先红断言：若 decrementStock 仍写 updated_at，被扣的那件会升到第 1 位，
    //    第 2 页就会重复第 1 页的末行并漏掉它（DB3-02 报告里的场景，实测复现）。
    expect([...p1.items, ...p2.items].map((r) => r.id).sort()).toEqual([...ids].sort());
    expect((await db`select stock from products where id = ${String(victim)}`)[0]?.stock).toBe(9);
  });

  it('⚠️ 下单扣库存**不**推进 products.updated_at（否则运营正在进行的编辑被成交作废）', async () => {
    const created = await repo().insertProduct(input({ stock: 10 }));
    await sleep(10);
    expect(await decrementStock(db, 'p-1', 1)).toBe(true);
    const after = (await repo().listAdminProducts({ page: 1, size: 1 })).items[0];
    expect(after?.stock).toBe(9); // 库存确实扣了
    expect(after?.updated_at.getTime()).toBe(created.updated_at.getTime()); // 但版本凭据没变
    // 于是：运营打开表单 → 买家下单 → 运营保存（AJ-175 钉住的行为）仍然成功
    const saved = await repo().updateProduct(
      'p-1',
      updateInput(created.updated_at.toISOString(), { title: '编辑期间来了单' }),
    );
    expect(saved.ok).toBe(true);
  });

  it('⚠️ 关单回补库存同样**不**推进 updated_at（与扣减对称）', async () => {
    const created = await repo().insertProduct(input({ stock: 10 }));
    await sleep(10);
    await incrementStock(db, 'p-1', 2);
    const after = (await repo().listAdminProducts({ page: 1, size: 1 })).items[0];
    expect(after?.stock).toBe(12);
    expect(after?.updated_at.getTime()).toBe(created.updated_at.getTime());
  });

  it('listAdminProducts：行含管理端专有列（cost_jpy / jan_code / purchase_source）', async () => {
    await repo().insertProduct(input({ cost_jpy: 2000, jan_code: '4901234567890' }));
    const list = await repo().listAdminProducts({ page: 1, size: 10 });
    expect(list.items[0]?.cost_jpy).toBe(2000);
    expect(list.items[0]?.jan_code).toBe('4901234567890');
  });

  it('🔴 库里 customs_desc_en 为 NULL → 读出来是 null，不是字面量 "null"（CAT-20）', async () => {
    // @why 直插 SQL 而不是走 insertProduct：写入形状把它定成必填 string（domain 必填），
    //      走正规路径**造不出** NULL——而库列是可空的，NULL 只来自绕过管理端的写入
    //      （手工 SQL / 批量导入 / seed）。验收"读侧不会凭空造值"必须造出这个脏行。
    await db`
      insert into products (id, title, category, price_jpy, weight_g, customs_desc_en, origin_country)
      values ('p-null-desc', '缺报关品名', 'beauty', 3600, 800, null, 'JP')
    `;
    const row = (await repo().listAdminProducts({ page: 1, size: 10 })).items[0];
    // ⚠️ 两条都要：只断言 `not.toBe('null')` 时，改成 `undefined` 也绿；
    //    只断言 `toBeNull()` 时……其实够了，但留着第二条是为了让"为什么"看得见。
    expect(row?.customs_desc_en).toBeNull();
    expect(row?.customs_desc_en).not.toBe('null');
  });

  it('updateProduct：改得到已填字段与可空字段（置 null 生效）', async () => {
    const created = await repo().insertProduct(
      input({ cost_jpy: 2000, jan_code: '4901234567890' }),
    );
    await sleep(10); // 让 now() 至少推进一个毫秒
    // ⚠️ 凭据**直接用 insert 回的 updated_at**（转毫秒精度的 ISO 串）：库里那一列是
    //    timestamptz，精度 **6 位（微秒）**，而客户端拿到的恒为毫秒。仓储里若丢了
    //    `date_trunc('millisecond', updated_at)`，两边永远不等 → 这一条**立刻变红**。
    //    该缺陷只在真库上出现（内存假仓储看不见），所以必须钉在真库用例里。
    const after = await repo().updateProduct(
      'p-1',
      updateInput(created.updated_at.toISOString(), { title: '改名后', jan_code: null }),
    );
    if (!after.ok) throw new Error(`本应命中，实际 ${after.reason}`);
    expect(after.row.title).toBe('改名后');
    expect(after.row.jan_code).toBeNull();
    expect(after.row.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
  });

  it('updateProduct：id 不存在 → not_found（路由层据此 40401，不是 40914）', async () => {
    expect(await repo().updateProduct('no-such', updateInput(new Date().toISOString()))).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('updateProduct：凭据是旧值 → stale，且**整行没被写**', async () => {
    const created = await repo().insertProduct(input({ price_jpy: 3600 }));
    const res = await repo().updateProduct(
      'p-1',
      updateInput(new Date(created.updated_at.getTime() - 60_000).toISOString(), {
        title: '覆盖者',
        price_jpy: 999,
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'stale' });
    const row = (await repo().listAdminProducts({ page: 1, size: 1 })).items[0];
    expect(row?.title).toBe('测试商品'); // 没被"覆盖者"写进去
    expect(row?.price_jpy).toBe(3600);
    expect(row?.updated_at.getTime()).toBe(created.updated_at.getTime()); // updated_at 也没被推进
  });

  it('updateProduct：A 打开表单后 B 先保存 → A 的凭据失效（真实并发场景）', async () => {
    const created = await repo().insertProduct(input({ price_jpy: 3600 }));
    const seenByA = created.updated_at; // A 打开编辑页那一刻读到的版本
    await sleep(10); // ⚠️ 必须让 B 的 now() 与 insert 的 now() 跨过同一个毫秒，否则本用例会 flaky
    const byB = await repo().updateProduct(
      'p-1',
      updateInput(seenByA.toISOString(), { price_jpy: 4200 }),
    );
    if (!byB.ok) throw new Error(`B 本应命中，实际 ${byB.reason}`);

    const byA = await repo().updateProduct(
      'p-1',
      updateInput(seenByA.toISOString(), { title: 'A 改的标题' }),
    );
    expect(byA).toEqual({ ok: false, reason: 'stale' });

    const row = (await repo().listAdminProducts({ page: 1, size: 1 })).items[0];
    expect(row?.price_jpy).toBe(4200); // B 的改价**没有被 A 回滚**
    expect(row?.title).toBe('测试商品'); // A 的标题也没写进去
  });

  it('setProductStatus：active ↔ offline 都能改；不存在 → false', async () => {
    await repo().insertProduct(input());
    expect(await repo().setProductStatus('p-1', 'offline')).toBe(true);
    expect((await repo().listAdminProducts({ page: 1, size: 1 })).items[0]?.status).toBe('offline');
    expect(await repo().setProductStatus('p-1', 'active')).toBe(true);
    expect(await repo().setProductStatus('no-such', 'offline')).toBe(false);
  });
});
