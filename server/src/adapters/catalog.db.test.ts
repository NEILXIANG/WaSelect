/**
 * 职责：`adapters/catalog.ts` 的真库用例（I1-U4，L1 层）——**D-46 运费取档红线**、
 *      承运商唯一性、关税率直查、fx 当日汇率选取，全部钉在真库上。
 *
 * @why 运费红线必须在真库测 SQL 而不是测 pickTier（factories 的内存版）：
 *      D-46 的事故现场就是"查询方向错了且静默"——内存版与 SQL 版各写一份，
 *      错的是 SQL 那份；这里的 7 条向量与 catalog.unit.test.ts（阶梯素材）同源，
 *      任何一边改阶梯都得回来面对它们。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { makeShippingRates } from '../../../test/factories/entities.js';
import { createCatalogRepo, type CatalogRepo } from './catalog.js';

let db: Db;
let repo: CatalogRepo;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  repo = createCatalogRepo(db);
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
});

/** 灌入整张占位运费阶梯（carrier 默认 'placeholder'，与 seed 同源）。 */
async function seedShipping(carrier = 'placeholder'): Promise<void> {
  for (const s of makeShippingRates(carrier)) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
}

describe('findShippingPriceJpy：D-46 红线向量（向上取档，与技术文档逐条一致）', () => {
  // [包裹重, 应收运费]；w=1850 → 4950 是头号红线（返回 4050 = 向下取档 = 每单少收约 1,000 円）
  const VECTORS: ReadonlyArray<readonly [number, number]> = [
    [100, 1400],
    [101, 1650],
    [500, 2150],
    [501, 3150],
    [1850, 4950],
    [2000, 4950],
    [2001, 6600],
  ];

  it('7 条红线向量逐条命中（含全部档界两侧）', async () => {
    await seedShipping();
    for (const [w, expected] of VECTORS) {
      const got = await repo.findShippingPriceJpy('placeholder', w);
      expect(got, `包裹重 ${w}g 应取 ${expected} 円`).toBe(expected);
    }
  });

  it('超重 → null（不能静默按最贵档收，路由层据此抛 50004）', async () => {
    await seedShipping();
    expect(await repo.findShippingPriceJpy('placeholder', 10_001)).toBeNull();
  });

  it('inactive 的档不参与取档', async () => {
    await seedShipping();
    await db`update shipping_rates set active = false where max_weight_g = 2000`;
    // 2000 档下线后，1850g 应向上取到 3000 档（6600），而不是取到 inactive 的 4950
    expect(await repo.findShippingPriceJpy('placeholder', 1850)).toBe(6600);
  });

  it('别的承运商的档不串', async () => {
    await seedShipping();
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values ('other', 100000, 1, true)
    `;
    expect(await repo.findShippingPriceJpy('placeholder', 1850)).toBe(4950);
    expect(await repo.findShippingPriceJpy('other', 1850)).toBe(1);
  });
});

describe('resolveSingleActiveCarrier（承运商选择规则未定前的唯一不含糊答案）', () => {
  it('恰好一家活跃 → 返回它', async () => {
    await seedShipping();
    expect(await repo.resolveSingleActiveCarrier()).toBe('placeholder');
  });

  it('零家 / 多家活跃 → null（路由层 50004，而不是悄悄挑一家）', async () => {
    expect(await repo.resolveSingleActiveCarrier()).toBeNull();
    await seedShipping('a');
    await seedShipping('b');
    expect(await repo.resolveSingleActiveCarrier()).toBeNull();
  });

  it('第二家全部 inactive 不影响唯一性判定', async () => {
    await seedShipping('a');
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values ('b', 1000, 999, false)
    `;
    expect(await repo.resolveSingleActiveCarrier()).toBe('a');
  });
});

describe('findDutyRate', () => {
  it("('JP','US') 命中迁移 010 的 seed（0.15，NUMERIC 原样字符串）", async () => {
    // duty_rates 是配置表：resetTestDb 不清它，seed 由迁移保证（见 010 文件头 @limitation 三）
    const rate = await repo.findDutyRate('JP', 'US');
    expect(Number(rate)).toBeCloseTo(0.15, 10);
  });

  it('无此 (origin,dest) 行 → null（报价据此给 duty_jpy=null，不阻单）', async () => {
    expect(await repo.findDutyRate('JP', 'CA')).toBeNull();
  });
});

describe('findLatestFxRates', () => {
  const NOW = new Date('2026-01-02T12:00:00.000Z');

  async function seedFx(quote: string, rate: string, effectiveFrom: Date): Promise<void> {
    await db`
      insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
      values (${quote}, ${rate}, ${rate}, 0.03, ${effectiveFrom})
    `;
  }

  it('每个币种取 effective_from <= now 的最新一行；未来行不算', async () => {
    await seedFx('USD', '0.0060', new Date('2026-01-01T00:00:00.000Z'));
    await seedFx('USD', '0.0067', new Date('2026-01-02T00:00:00.000Z'));
    await seedFx('USD', '0.0099', new Date('2026-01-03T00:00:00.000Z')); // 明日汇率，提前录入
    await seedFx('CNY', '0.049', new Date('2026-01-02T00:00:00.000Z'));
    const m = await repo.findLatestFxRates(['USD', 'CNY'], NOW);
    expect(m.get('USD')).toBe('0.00670000');
    expect(m.get('CNY')).toBe('0.04900000');
  });

  it('缺失的币种不在 map 里（调用方据此 50003，不是拿到 undefined 还不知道谁缺）', async () => {
    await seedFx('USD', '0.0067', new Date('2026-01-02T00:00:00.000Z'));
    const m = await repo.findLatestFxRates(['USD', 'CNY'], NOW);
    expect(m.has('USD')).toBe(true);
    expect(m.has('CNY')).toBe(false);
  });

  it('空币种列表 → 空 map（不查库也不报错）', async () => {
    expect((await repo.findLatestFxRates([], NOW)).size).toBe(0);
  });
});

describe('findProductsForQuote', () => {
  it('按 id 批量取快照（数值列转成 number）；不存在的 id 不出现', async () => {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
      values ('p-a', 'Knife', 'kitchen', 8800, 620, 5, 'JP', 'active'),
             ('p-b', 'Cup', 'kitchen', 3200, 480, 0, 'JP', 'offline')
    `;
    const rows = await repo.findProductsForQuote(['p-a', 'p-b', 'ghost']);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === 'p-a');
    expect(a).toMatchObject({ price_jpy: 8800, weight_g: 620, stock: 5, status: 'active' });
    expect(typeof a?.price_jpy).toBe('number');
  });

  it('空 id 列表 → 空数组（不发 SQL）', async () => {
    expect(await repo.findProductsForQuote([])).toEqual([]);
  });
});

describe('listActiveProducts / findProductDetail（U5a）', () => {
  async function seedProducts(): Promise<void> {
    await db`
      insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status, description, compliance_tags, images)
      values ('p-1', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active', 'sharp', '[]'::jsonb, '["k1.jpg"]'::jsonb),
             ('p-2', 'Face Cream', 'beauty', 3200, 480, 10, 'JP', 'active', null, '["cosmetic"]'::jsonb, '[]'::jsonb),
             ('p-3', 'Old Cup', 'daily', 1000, 300, 0, 'JP', 'offline', null, '[]'::jsonb, '[]'::jsonb)
    `;
  }

  it('只出上架商品；total 与 items 一致；新到旧排序', async () => {
    await seedProducts();
    const r = await repo.listActiveProducts({ page: 1, size: 20 });
    expect(r.total).toBe(2);
    expect(r.items.map((p) => p.id).sort()).toEqual(['p-1', 'p-2']);
    expect(typeof r.items[0]?.price_jpy).toBe('number');
  });

  it('分页：size=1 时两页各一条，total 不变', async () => {
    await seedProducts();
    const p1 = await repo.listActiveProducts({ page: 1, size: 1 });
    const p2 = await repo.listActiveProducts({ page: 2, size: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p2.items).toHaveLength(1);
    expect(p1.total).toBe(2);
    expect(p1.items[0]?.id).not.toBe(p2.items[0]?.id);
  });

  it('category 过滤与 keyword（ILIKE 子串）', async () => {
    await seedProducts();
    const byCat = await repo.listActiveProducts({ page: 1, size: 20, category: 'beauty' });
    expect(byCat.items.map((p) => p.id)).toEqual(['p-2']);
    const byKw = await repo.listActiveProducts({ page: 1, size: 20, keyword: 'knife' });
    expect(byKw.items.map((p) => p.id)).toEqual(['p-1']); // ilike：小写命中大写
  });

  it('keyword 里的 % 与 _ 被转义（不当通配符）', async () => {
    await seedProducts();
    const r = await repo.listActiveProducts({ page: 1, size: 20, keyword: '%' });
    expect(r.items).toHaveLength(0); // "%" 字面量不存在于任何标题
  });

  it('findProductDetail：详情含下架行（40401 判定在路由）；不存在 → null', async () => {
    await seedProducts();
    const off = await repo.findProductDetail('p-3');
    expect(off?.status).toBe('offline');
    const on = await repo.findProductDetail('p-2');
    expect(on).toMatchObject({ title: 'Face Cream', weight_g: 480, origin_country: 'JP' });
    expect(await repo.findProductDetail('ghost')).toBeNull();
  });
});
