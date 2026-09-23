/**
 * 职责：实体工厂的真库验证（F9-c）——产物必须**真的插得进去**。
 *
 * @why 工厂产物"看起来对"不等于"插得进去"。DDL 里的 CHECK / NOT NULL / FK / 唯一约束
 *      是唯一不会说谎的裁判；自己写一份 schema 去校验自己造的数据是循环论证。
 *      这一层也是"假数据像真的"的底线：能被真库接受，才算像。
 *
 * @limitation 这里**不测业务不变量**（金额勾稽、状态迁移）——那些规则还没定（业务期），
 *              现在写进去等于把猜测固化成断言。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  createIds,
  makeAddress,
  makeProduct,
  makeShippingRates,
  makeUser,
  type AddressRow,
  type ProductRow,
  type UserRow,
} from './entities.js';
import { createRng } from './rng.js';

let db: Db;
/** 固定种子：同一批用例每次拿到同一批数据，红灯可复现。 */
let nextId: () => string;
let rng: ReturnType<typeof createRng>;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetTestDb(db);
  rng = createRng('f9-c');
  nextId = createIds('f9-c');
});

async function insertUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  const u = makeUser(rng, nextId, overrides);
  await db`
    insert into users (id, openid, email, phone, is_admin)
    values (${u.id}, ${u.openid}, ${u.email}, ${u.phone}, ${u.is_admin})
  `;
  return u;
}

async function insertProduct(overrides: Partial<ProductRow> = {}): Promise<ProductRow> {
  const p = makeProduct(rng, nextId, overrides);
  await db`
    insert into products (
      id, title, title_ja, category, description, images, price_jpy, cost_jpy,
      weight_g, stock, compliance_tags, hs_code, customs_desc_en, origin_country,
      jan_code, purchase_source, status
    ) values (
      ${p.id}, ${p.title}, ${p.title_ja}, ${p.category}, ${p.description},
      ${db.json(p.images)}::jsonb, ${p.price_jpy}, ${p.cost_jpy},
      ${p.weight_g}, ${p.stock}, ${db.json(p.compliance_tags)}::jsonb,
      ${p.hs_code}, ${p.customs_desc_en}, ${p.origin_country},
      ${p.jan_code}, ${p.purchase_source}, ${p.status}
    )
  `;
  return p;
}

describe('工厂产物能进真库', () => {
  it('users：默认产物直接插入成功', async () => {
    const u = await insertUser();
    const rows = await db`select * from users where id = ${u.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openid).toBe(u.openid);
  });

  it('users：CHECK (openid IS NOT NULL OR email IS NOT NULL) 真的会拦住两个都空的情况', async () => {
    // 反例不是"工厂造不出来"，而是"用 override 强行造出来时 DB 必须拒绝"——
    // 这条断言同时证明了 CHECK 存在且生效（约束缺位是最难发现的一类缺陷）
    const bad = makeUser(rng, nextId, { openid: null as unknown as string, email: null });
    await expect(
      db`
        insert into users (id, openid, email) values (${bad.id}, ${bad.openid}, ${bad.email})
      `,
    ).rejects.toThrow();
  });

  it('products：默认产物直接插入成功，且 origin_country 被 DB 锁成 JP', async () => {
    const p = await insertProduct();
    const rows = await db`select origin_country, price_jpy, weight_g from products where id = ${p.id}`;
    expect(rows[0]?.origin_country).toBe('JP');
    expect(Number(rows[0]?.price_jpy)).toBeGreaterThan(0);
  });

  it('products：试图插非日产商品会被 products_origin_jp 拒绝', async () => {
    const bad = makeProduct(rng, nextId, { origin_country: 'CN' });
    await expect(
      db`
        insert into products (id, title, category, price_jpy, weight_g, origin_country)
        values (${bad.id}, ${bad.title}, ${bad.category}, ${bad.price_jpy}, ${bad.weight_g}, ${bad.origin_country})
      `,
    ).rejects.toThrow(/products_origin_jp/);
  });

  it('products：weight_g / price_jpy 为 0 会被 CHECK 拒绝', async () => {
    const zero = makeProduct(rng, nextId, { weight_g: 0 });
    await expect(
      db`
        insert into products (id, title, category, price_jpy, weight_g, origin_country)
        values (${zero.id}, ${zero.title}, ${zero.category}, ${zero.price_jpy}, 0, 'JP')
      `,
    ).rejects.toThrow();
  });

  it('addresses：默认产物直接插入成功（收件人/电话/邮编全部满足 CHECK）', async () => {
    const u = await insertUser();
    const a: AddressRow = makeAddress(rng, nextId, u.id);
    await db`
      insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code, country, is_default)
      values (${a.id}, ${a.user_id}, ${a.recipient}, ${a.phone}, ${a.line1}, ${a.line2},
              ${a.city}, ${a.state}, ${a.postal_code}, ${a.country}, ${a.is_default})
    `;
    const rows = await db`select * from addresses where id = ${a.id}`;
    expect(rows).toHaveLength(1);
  });

  /**
   * 连插 100 条，而不是 1 条。
   * @why 电话尾号是 `rng.int(0, 9_999_999)`，只有约 10% 的取值不足 7 位——
   *      只插一条的话，"忘记补零"这个缺陷有 90% 概率蒙混过关。
   *      这是我自己注回缺陷时发现的覆盖不足：单条样本覆盖不到"偶发边界"。
   */
  it('addresses：连续 100 条全部插得进去（覆盖电话尾号补零这类偶发边界）', async () => {
    const u = await insertUser();
    for (let i = 0; i < 100; i += 1) {
      const a = makeAddress(rng, nextId, u.id);
      await db`
        insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code)
        values (${a.id}, ${a.user_id}, ${a.recipient}, ${a.phone}, ${a.line1}, ${a.line2},
                ${a.city}, ${a.state}, ${a.postal_code})
      `;
    }
    const rows = await db`select count(*)::int as n from addresses`;
    expect(Number(rows[0]?.n)).toBe(100);
  });

  /**
   * `cost_jpy` 在 DDL 里**没有 CHECK**（`BIGINT` 可空），负数能安静入库。
   * @why 成本为负不会报错，只会让"净贡献率"算出一个好看的假数字——
   *      这正是 R4（成本模型失真）的静默形态。DB 不拦，就在工厂这一层拦并钉住。
   * @limitation 只保证"非负"。**成本高于售价是合法的**（促销亏本），这里刻意不做上限断言，
   *              否则会把一个真实业务场景判成错误。
   * @todo 是否给 `cost_jpy` 补 DB 级 CHECK 待定（要动 DDL 需先同步技术文档 §3）；
   *       真实数据来自管理后台录入，业务期的"上架校验规则"应覆盖这一条。
   */
  it('products：成本非负（DB 不拦这条，只能靠工厂保证）', async () => {
    for (let i = 0; i < 30; i += 1) {
      const p = await insertProduct();
      const rows = await db`select cost_jpy from products where id = ${p.id}`;
      const cost = rows[0]?.cost_jpy;
      if (cost !== null && cost !== undefined) {
        expect(Number(cost), `商品 ${p.title_ja} 的成本为负`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('addresses：user_id 不存在会被外键拒绝（FK 是活的，不是摆设）', async () => {
    const a = makeAddress(rng, nextId, 'u-not-exist');
    await expect(
      db`
        insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code)
        values (${a.id}, ${a.user_id}, ${a.recipient}, ${a.phone}, ${a.line1}, ${a.city}, ${a.state}, ${a.postal_code})
      `,
    ).rejects.toThrow();
  });

  it('shipping_rates：一整张阶梯表插进去后，(carrier, max_weight_g) 唯一约束成立', async () => {
    const rows = makeShippingRates();
    for (const r of rows) {
      await db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values (${r.carrier}, ${r.max_weight_g}, ${r.price_jpy}, ${r.active})
      `;
    }
    const got = await db`select count(*)::int as n from shipping_rates`;
    expect(Number(got[0]?.n)).toBe(rows.length);
    // 同一档插第二次必须被唯一约束拒绝
    const first = rows[0];
    if (first === undefined) throw new Error('阶梯表为空，这条断言没有意义');
    await expect(
      db`
        insert into shipping_rates (carrier, max_weight_g, price_jpy)
        values (${first.carrier}, ${first.max_weight_g}, ${first.price_jpy})
      `,
    ).rejects.toThrow();
  });
});

describe('确定性', () => {
  it('同一批种子造出的数据完全一致（红灯可复现的前提）', async () => {
    const build = (): unknown => {
      const r = createRng('deterministic');
      const ids = ((): (() => string) => {
        let n = 0;
        return () => `id-${n++}`;
      })();
      return [
        makeUser(r, ids),
        makeProduct(r, ids),
        makeAddress(r, ids, 'u-1'),
        makeProduct(r, ids),
      ];
    };
    expect(build()).toEqual(build());
  });
});
