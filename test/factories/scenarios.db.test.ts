/**
 * 职责：场景集的真库验证（F9-d，L1 层）。
 *
 * @why 这一层要验三件事，各自对应一条独立的失败形态：
 *      ① **场景必须整体入库**——单个工厂"插得进去"已在 entities.db 验过，
 *         但"一组有引用关系的实体"能不能整体进去（FK、JSONB 列序）只有整体试才知道；
 *      ② **跨档边界必须命中预期档**——取档方向（向上）是 D-46 用钱买回来的红线，
 *         边界两侧是唯一会被"向下取档"改坏的地方；
 *      ③ **同一种子两次必须完全一致**——F9 的验收标准之一；
 *         场景集若含任何非确定性，"灌两次的店不一样"会让基于它的断言随机红。
 *
 * @see scenarios.ts（被测）；seed-bundle.ts（入库实现）；catalog.ts（SHIPPING_TIERS / pickTier）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import { createIds } from './entities.js';
import { createRng } from './rng.js';
import { insertBundle } from './seed-bundle.js';
import { demoShop, fullCatalog, TIER_REDLINE_CASES, tierBoundaryCases } from './scenarios.js';
import { JP_PRODUCTS, pickTier, SHIPPING_TIERS } from './catalog.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetTestDb(db);
});

describe('场景整体入库（FK 与 JSONB 列序）', () => {
  it('fullCatalog：全部目录 + 全部运费档 + 用户 + 默认地址，一次灌入', async () => {
    const bundle = fullCatalog(createRng('f9-d'), createIds('f9-d'));
    const counts = await insertBundle(db, bundle);
    expect(counts.users).toBe(1);
    expect(counts.addresses).toBe(1);
    expect(counts.products).toBeGreaterThan(0);
    expect(counts.shippingRates).toBe(SHIPPING_TIERS.length);

    // 从库侧核对行数，而不是只信 insertBundle 的返回值（它可能数对但插错表）
    const users = await db`select count(*)::int as n from users`;
    const products = await db`select count(*)::int as n from products`;
    const rates = await db`select count(*)::int as n from shipping_rates`;
    expect(Number(users[0]?.n)).toBe(1);
    expect(Number(products[0]?.n)).toBe(counts.products);
    expect(Number(rates[0]?.n)).toBe(SHIPPING_TIERS.length);

    // 默认地址的 user_id 必须真指向那个用户（FK 之外的语义自洽）
    const orphans = await db`
      select count(*)::int as n from addresses a
      where not exists (select 1 from users u where u.id = a.user_id)`;
    expect(Number(orphans[0]?.n)).toBe(0);

    // JSONB 写入必须是**单重编码**（U6a 防复发）：SQL 侧能提取才算数——
    // 双重编码（`${JSON文本}::jsonb` 或 stringify 后裸传）时列里是字符串标量，
    // 读侧双重解码"看起来正常"，只有 `->>` 会静默返回 null（探针实锤）
    const imgProbe = await db`
      select count(*)::int as n from products
      where jsonb_typeof(images) = 'array' and jsonb_typeof(compliance_tags) = 'array'`;
    expect(Number(imgProbe[0]?.n)).toBe(counts.products);
  });

  it('demoShop：4 商品 + 完整运费档', async () => {
    const counts = await insertBundle(db, demoShop(createRng('f9-d'), createIds('f9-d')));
    expect(counts.products).toBe(4);
    expect(counts.shippingRates).toBe(SHIPPING_TIERS.length);
    // 从库侧核对，而不是只信 insertBundle 的返回值——注入④证明：
    // 漏插 products 时返回值仍是 4，只有查库才能抓到（demoShop 原先只信返回值，补这条）
    const products = await db`select count(*)::int as n from products`;
    const rates = await db`select count(*)::int as n from shipping_rates`;
    expect(Number(products[0]?.n)).toBe(4);
    expect(Number(rates[0]?.n)).toBe(SHIPPING_TIERS.length);
  });
});

describe('目录场景：每件商品的文案属于它自己（三端联动模拟 2026-10-08）', () => {
  it('🔴 why / maker / tags 与同名素材一致（原先落回 makeProduct 随机抽的另一件：香蕉蛋糕配化妆水的推荐语）', () => {
    for (const seedName of ['a', 'b', 'c']) {
      const bundle = fullCatalog(createRng(seedName), createIds(seedName));
      for (const p of bundle.products) {
        const src = JP_PRODUCTS.find((s) => s.title === p.title);
        expect(src, p.title).toBeDefined();
        expect(p.why, p.title).toBe(src?.why);
        expect(p.maker, p.title).toBe(src?.maker === '' ? null : src?.maker);
        expect(p.tags, p.title).toEqual(src?.tags);
      }
      expect(new Set(bundle.shippingRates.map((r) => r.carrier))).toEqual(
        new Set(['Japan Post EMS']),
      );
    }
  });
});

describe('跨档边界（D-46 红线）', () => {
  it('派生向量的数量 = 2 × 档数（防派生循环写坏 → 全部用例静默消失）', () => {
    // @why 派生循环一旦写坏（比如从 i=1 开始、或忘了上限+1 那条），用例会**变少而不是变红**——
    //      这是扫描/生成类门禁的经典假绿（§2 第 34 条）。钉住数量才能区分"全过"与"没跑"。
    expect(tierBoundaryCases()).toHaveLength(SHIPPING_TIERS.length * 2);
  });

  it('每条派生边界向量都命中预期档', () => {
    for (const c of tierBoundaryCases()) {
      expect(pickTier(c.weightG), c.why).toBe(c.expect);
    }
  });

  it('红线向量独立于派生逻辑钉住（1850→4950，不是 4050）', () => {
    // @why 派生循环和 pickTier 若被同一个错法（向下取档）同时改坏，派生用例会跟着错、照样绿；
    //      只有"推导链之外的已知答案"能抓出来（§2 第 25 条：独立参考向量）。
    for (const c of TIER_REDLINE_CASES) {
      expect(pickTier(c.weightG), c.why).toBe(c.expect);
    }
    // 额外钉死最关键的一条的**价格**，而不只是档对象：错的取档错的是钱
    expect(pickTier(1850)?.priceJpy).toBe(4950);
  });
});

describe('确定性（F9 验收：同一种子两次完全一致）', () => {
  it('同一 seed 两次 fullCatalog 产物 deep equal', () => {
    const a = fullCatalog(createRng('determinism'), createIds('determinism'));
    const b = fullCatalog(createRng('determinism'), createIds('determinism'));
    expect(a).toEqual(b);
  });

  it('不同 seed 的产物确实不同（防"恒定实现"冒充确定性）', () => {
    // @why 若哪天有人为了"通过确定性测试"把随机字段全改成固定值，第一条会绿、
    //      但"假数据像真的"就没了。这一条守住的是"确定不等于恒定"。
    const a = fullCatalog(createRng('seed-1'), createIds('seed-1'));
    const b = fullCatalog(createRng('seed-2'), createIds('seed-2'));
    expect(a.users[0]?.openid).not.toBe(b.users[0]?.openid);
  });
});
