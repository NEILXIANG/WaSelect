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
import { ensureTestDb, resetTestDb, testDb } from '../test/db/test-db.js';
import { clearBusinessTables, seedOnce } from './seed-lib.js';
import { SHIPPING_TIERS } from '../test/factories/catalog.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  // ⚠️ 必须先重置：db project 的多个文件**共享同一个测试库**且跨文件不清理，
  //    别的文件留下的订单/支付行会让 `seedOnce` 的内容闸门（闸门④）拒绝清表，
  //    表现为"单独跑这个文件绿、全量跑红"——这是本文件先踩到的一次
  //    （2026-09-29，加内容闸门后全量 db 立刻红了两条）。
  //    @why 用 `resetTestDb` 而不是 `clearBusinessTables`：前者是测试库的标准重置入口，
  //    且它**不带**内容闸门（测试库名以 `_test` 结尾，已由 assertIsTestDatabaseUrl 保证），
  //    不会被"库里恰好有真订单"挡住——那正是生产保护该有的样子，测试环境不该被它绊倒。
  await resetTestDb(db);
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

describe('闸门④：内容闸门（B31 纵深防御：名字拦不住时靠数据拦）', () => {
  /**
   * @why 全量审查 B31（2026-09-29）：闸门①（只灌本机）与闸门②（库名拒 prod）都是**名字层**的。
   *      名字层的闸门有一个共同的死法——开发者为排查生产问题开了 `localhost:15432 → Render 库`
   *      的隧道：此时 host 是 localhost（①放行），库名若将来又被改回 `japan_shop`（②也放行）。
   *      内容闸门不认名字，只认**数据**：库里只要有"真业务"的痕迹就拒，
   *      因为 dev 库里的订单只能是审核期测试单（`is_test=true`）、支付行只能来自 mock。
   * @why 判据取"is_test=false 的订单"与"provider <> mock 的支付行"两条，而不是"orders 非空"：
   *      本地开发本来就会下测试单（那是正常业务），按"非空"拦会把日常开发挡死，
   *      于是有人会把闸门删掉——拦太宽比不拦更危险（与闸门②不拦 "produce" 同一条理由）。
   */

  /** 造一个最小用户（只填 NOT NULL 列）。 */
  async function someUserId(): Promise<string> {
    await seedOnce(db, {});
    const u = await db`select id from users limit 1`;
    return String(u[0]?.id);
  }

  /** 造一张最小订单（expires_at 用 now()，形状合规即可）。 */
  async function insertOrder(id: string, userId: string, isTest: boolean): Promise<void> {
    await db`
      insert into orders (id, order_no, user_id, items_jpy, total_jpy, fx_snapshot,
                          address_snapshot, terms_version, expires_at, is_test)
      values (${id}, ${`no-${id}`}, ${userId}, 1000, 1000, '{}'::jsonb,
              '{}'::jsonb, 'terms-1', now(), ${isTest})
    `;
  }

  it('有 is_test=false 的订单 → 拒绝清表，且那张单还在', async () => {
    const userId = await someUserId();
    await insertOrder('ord-real-1', userId, false);
    await expect(seedOnce(db, {})).rejects.toThrow(/真订单|生产/);
    // 拒绝之后必须**什么都没动**（防"拒了但已经 truncate 了"）
    const left = await db`select id from orders where id = 'ord-real-1'`;
    expect(left.length).toBe(1);
    await resetTestDb(db);
  });

  it('有非 mock 通道的支付行 → 拒绝清表', async () => {
    const userId = await someUserId();
    await insertOrder('ord-real-2', userId, true);
    await db`
      insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
      values ('pay-stripe-1', 'ord-real-2', 'stripe', 'succeeded', 'USD', 1000)
    `;
    await expect(seedOnce(db, {})).rejects.toThrow(/生产|非 mock/);
    const left = await db`select id from payments where id = 'pay-stripe-1'`;
    expect(left.length).toBe(1);
    await resetTestDb(db);
  });

  it('只有审核期测试单与 mock 支付行 → 放行（不能把日常开发挡死）', async () => {
    const userId = await someUserId();
    await insertOrder('ord-test-1', userId, true);
    await db`
      insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
      values ('pay-mock-1', 'ord-test-1', 'mock', 'succeeded', 'JPY', 1000)
    `;
    await expect(seedOnce(db, {})).resolves.toBeDefined();
    // 灌进去了 = 清过了：刚才那张测试单没了
    const left = await db`select id from orders where id = 'ord-test-1'`;
    expect(left.length).toBe(0);
  });
});
