/**
 * 职责：把工厂产物写进库（F9-d 的「入库」半）——单行 INSERT 的**唯一实现点**。
 *
 * @why 工厂只负责"造数据"。INSERT 若散写在每个测试文件与 seed 脚本里，会出现
 *      "测试插进去了、seed 脚本漏插一张表"或"列序两处不一致"的漂移。
 *      这里把每张表的单行 INSERT 收敛成各一个函数，seed 脚本、db 测试、反例库共用。
 *
 * @why JSONB 列用 `db.json()`（U6a 更正）：`JSON.stringify` 成字符串再当参数传，
 *      驱动会按推断出的 jsonb 参数类型**再编码一次**（双重编码——列里存字符串标量，
 *      `->>` 提取 null；裸传 JS 数组则按 PG 数组序列化报 42883，F9 踩的是这半边）。
 *      `db.json()` 让驱动自己做那一次且仅那一次 JSON 编码，两种坑都避开。
 *
 * @limitation 一：只管"插"，不管"清"。清表（`resetTestDb` / 将来的一键灌数据脚本）由调用方决定——
 *              合在一起会让"我只想追加一条"也付出清空全库的代价。
 * @limitation 二：插入顺序固定 user → address → product → shipping_rate，靠 FK 决定
 *              （address.user_id 指向 user.id）。它不检查"bundle 里的引用是否自洽"
 *              （比如 address.user_id 是否真在 users 里）——那是调用方的责任，FK 会兜底报错。
 *
 * @see scenarios.ts（SeedBundle 的来源）；entities.ts（行结构）；migrations/001_init.sql（列与约束）
 */
import type { Db } from '../../server/src/adapters/db.js';
import type { AddressRow, ProductRow, ShippingRateRow, UserRow } from './entities.js';
import type { SeedBundle } from './scenarios.js';

export async function insertUserRow(db: Db, u: UserRow): Promise<void> {
  await db`
    insert into users (id, openid, email, phone, is_admin)
    values (${u.id}, ${u.openid}, ${u.email}, ${u.phone}, ${u.is_admin})
  `;
}

export async function insertAddressRow(db: Db, a: AddressRow): Promise<void> {
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code, country, is_default)
    values (${a.id}, ${a.user_id}, ${a.recipient}, ${a.phone}, ${a.line1}, ${a.line2},
            ${a.city}, ${a.state}, ${a.postal_code}, ${a.country}, ${a.is_default})
  `;
}

export async function insertProductRow(db: Db, p: ProductRow): Promise<void> {
  await db`
    insert into products (
      id, title, title_ja, category, description, images, price_jpy, cost_jpy,
      weight_g, stock, compliance_tags, hs_code, customs_desc_en, origin_country,
      jan_code, purchase_source, status, why, maker, tags
    ) values (
      ${p.id}, ${p.title}, ${p.title_ja}, ${p.category}, ${p.description}, ${db.json(p.images)},
      ${p.price_jpy}, ${p.cost_jpy}, ${p.weight_g}, ${p.stock}, ${db.json(p.compliance_tags)},
      ${p.hs_code}, ${p.customs_desc_en}, ${p.origin_country}, ${p.jan_code}, ${p.purchase_source}, ${p.status},
      ${p.why}, ${p.maker}, ${db.json(p.tags)}
    )
  `;
}

export async function insertShippingRateRow(db: Db, s: ShippingRateRow): Promise<void> {
  await db`
    insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
    values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
  `;
}

/**
 * 把一个 SeedBundle 整体写进库。顺序靠 FK 决定（见 @limitation 二）。
 * @returns 各表写入行数（供 seed 脚本打印确认）。
 */
export async function insertBundle(
  db: Db,
  bundle: SeedBundle,
): Promise<{ users: number; addresses: number; products: number; shippingRates: number }> {
  for (const u of bundle.users) await insertUserRow(db, u);
  for (const a of bundle.addresses) await insertAddressRow(db, a);
  for (const p of bundle.products) await insertProductRow(db, p);
  for (const s of bundle.shippingRates) await insertShippingRateRow(db, s);
  return {
    users: bundle.users.length,
    addresses: bundle.addresses.length,
    products: bundle.products.length,
    shippingRates: bundle.shippingRates.length,
  };
}
