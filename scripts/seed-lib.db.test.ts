/**
 * 职责：一键灌数据的真库验证（F9-f，L1 层）——**幂等**与**配置表保留**。
 *
 * @why 这两件事是一键灌数据最容易"看着对、实则错"的地方：
 *      - 幂等：若"先清再灌"漏了清，第二次跑会撞主键 → 报错；若漏了灌，库里是空的 → 不报错。
 *        只有"跑两次、再数一遍库"能区分。
 *      - 配置表保留：truncate 若把 `country_profiles` 也清了，dev 库就与生产不同构，
 *        而且**没有任何机制自动补回 seed**（§2 第 36 条）——这条闸门一松就是一片红。
 *
 * @see scripts/seed-lib.ts（被测）；test/db/test-db.ts（配置表排除口径）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../server/src/adapters/db.js';
import { ensureTestDb, testDb } from '../test/db/test-db.js';
import { clearBusinessTables, seedOnce } from './seed-lib.js';
import { SHIPPING_TIERS } from '../test/factories/catalog.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await db.end();
});

/** 数几张表的行数（从库侧，而不是信 seedOnce 的返回值）。 */
async function counts(): Promise<{ products: number; users: number; rates: number }> {
  const p = await db`select count(*)::int as n from products`;
  const u = await db`select count(*)::int as n from users`;
  const r = await db`select count(*)::int as n from shipping_rates`;
  return {
    products: Number(p[0]?.n),
    users: Number(u[0]?.n),
    rates: Number(r[0]?.n),
  };
}

describe('幂等（先清再灌）', () => {
  it('连灌两次 demoShop：不撞主键，且两次后的库一模一样', async () => {
    await seedOnce(db, {});
    const first = await counts();
    await seedOnce(db, {}); // 第二次：若没先清，这里会撞主键
    const second = await counts();
    expect(second).toEqual(first);
    expect(second.products).toBe(4);
    expect(second.users).toBe(1);
    expect(second.rates).toBe(SHIPPING_TIERS.length);
  });

  it('full 模式灌完整目录，且数量与商品目录一致', async () => {
    const { counts: c } = await seedOnce(db, { full: true });
    expect(c.products).toBeGreaterThan(4);
    expect((await counts()).products).toBe(c.products);
  });
});

describe('配置表保留（闸门③）', () => {
  it('clearBusinessTables 之后，country_profiles 的 US 种子仍在', async () => {
    await clearBusinessTables(db);
    const us = await db`select code, active from country_profiles where code = 'US'`;
    expect(us.length).toBe(1);
    // 业务表确实被清了（防"这条断言因为压根没清而绿"）
    expect((await counts()).products).toBe(0);
  });

  it('seedOnce 之后配置表仍在（灌数据不毁配置）', async () => {
    await seedOnce(db, {});
    const us = await db`select code from country_profiles where code = 'US'`;
    expect(us.length).toBe(1);
    expect((await counts()).products).toBe(4);
  });
});
