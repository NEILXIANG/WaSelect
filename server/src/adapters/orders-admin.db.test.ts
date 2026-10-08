/**
 * 职责：`adapters/orders-admin.ts`（管理端订单读仓储）的真库用例（I2 U-B1）。
 *
 * @why 管理端查询与买家侧**必须分成两套 SQL**：买家侧的每条查询都带 `user_id =`
 *      （orders.ts @why：归属过滤进 WHERE，写错就是越权读取）。管理端若复用它们，
 *      要么得伪造 user_id，要么会把"跨用户"这个性质加到买家侧函数上——
 *      两者都会让"越权"变得难以一眼看出。分开后："没有 user_id 过滤"是这套文件的
 *      固有属性，而它的调用方只有一个（admin 路由，有守卫）。
 *
 * @why keyword 三字段（单号 / 收件人 / 运单号）各自一条用例：它们来自三个不同的列
 *      （其中收件人在 `address_snapshot` JSONB 里），任一列取错都不会报错，
 *      只会"搜不到"——而客服搜不到单，就等于这条路由没做。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  findAdminOrder,
  listAdminOrders,
  listEventsFor,
  listOrderItemsFor,
  listPaymentsFor,
} from './orders-admin.js';

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

/** 插一个订单（够用的最小列集）。 */
async function insertOrder(o: {
  id: string;
  orderNo?: string;
  status?: string;
  recipient?: string;
  trackingNo?: string | null;
  hasDispute?: boolean;
  isTest?: boolean;
}): Promise<void> {
  await db`
    insert into users (id, openid) values (${`u-${o.id}`}, ${`o-${o.id}`})
      on conflict (id) do nothing
  `;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${o.id}`}, '商品', 'daily', 1000, 500, 'JP')
      on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        carrier, tracking_no, has_dispute, is_test, expires_at)
    values (${o.id}, ${o.orderNo ?? `NO-${o.id}`}, ${`u-${o.id}`}, ${o.status ?? 'paid'},
            1000, 500, 150, 1650, 500,
            ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ recipient: o.recipient ?? 'Jane Doe', line1: '1 Infinite Loop' } as never)},
            'TOS-TEST-1', 'placeholder', ${o.trackingNo ?? null},
            ${o.hasDispute ?? false}, ${o.isTest ?? false}, now() + interval '30 minutes')
  `;
  await db`
    insert into order_items (id, order_id, product_id, title_snapshot, qty, unit_price_jpy,
                             weight_g, declared_value_usd)
    values (${`oi-${o.id}`}, ${o.id}, ${`p-${o.id}`}, '商品', 1, 1000, 500, 7)
  `;
  // ⚠️ `charge_amount` 是**最小单位**（USD=分），必须与上面的 fx 自洽：
  //    1000 円 × 0.0067 = 6.70 美元 = **670 分**。
  //    曾经写 11（像是把"6.7 美元"随手取整）——它掩盖了"最小单位 vs 主单位"这层，
  //    于是前端把 3350 显示成 `USD 3350`（读大 100 倍）这类错在夹具里永远看不出来（B43 / AJ-214）。
  const chargeMinor = Math.round(1000 * 0.0067 * 100);
  await db`
    insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
    values (${`pay-${o.id}`}, ${o.id}, 'stripe', 'succeeded', 'USD', ${chargeMinor})
  `;
  await db`
    insert into order_events (order_id, status, note, actor) values (${o.id}, 'paid', '落账', 'sys')
  `;
}

describe('orders-admin（管理端订单读仓储，I2 U-B1）', () => {
  it('listAdminOrders：不带 status = 全部；带 status 只给该状态', async () => {
    await insertOrder({ id: 'o-1', status: 'paid' });
    await insertOrder({ id: 'o-2', status: 'shipped' });
    const all = await listAdminOrders(db, { page: 1, size: 20 });
    expect(all.total).toBe(2);
    const paid = await listAdminOrders(db, { page: 1, size: 20, statuses: ['paid'] });
    expect(paid.items).toHaveLength(1);
    expect(paid.items[0]?.id).toBe('o-1');
    // @why total 必须是**过滤后**的条数（分页条数按它算）。只断言 items 长度的话，
    //      计数 SQL 漏掉 WHERE 时前几页照样看着对，翻到最后一页才发现分页器在撒谎。
    expect(paid.total).toBe(1);
  });

  it('keyword 命中 order_no', async () => {
    await insertOrder({ id: 'o-1', orderNo: 'NO-UNIQUE-1' });
    await insertOrder({ id: 'o-2', orderNo: 'NO-OTHER-2' });
    const r = await listAdminOrders(db, { page: 1, size: 20, keyword: 'UNIQUE' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.order_no).toBe('NO-UNIQUE-1');
  });

  it('keyword 命中收件人（address_snapshot JSONB 里的 recipient）', async () => {
    await insertOrder({ id: 'o-1', recipient: 'Zhang San' });
    await insertOrder({ id: 'o-2', recipient: 'Li Si' });
    const r = await listAdminOrders(db, { page: 1, size: 20, keyword: 'Zhang' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.id).toBe('o-1');
  });

  it('keyword 命中运单号（tracking_no）', async () => {
    await insertOrder({ id: 'o-1', trackingNo: 'TRACK-999' });
    await insertOrder({ id: 'o-2', trackingNo: null });
    const r = await listAdminOrders(db, { page: 1, size: 20, keyword: 'TRACK-999' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.tracking_no).toBe('TRACK-999');
  });

  it('行含管理端专有列（user_id / has_dispute / is_test）', async () => {
    await insertOrder({ id: 'o-1', hasDispute: true, isTest: true });
    const r = await listAdminOrders(db, { page: 1, size: 20, includeTest: true });
    expect(r.items[0]?.user_id).toBe('u-o-1');
    expect(r.items[0]?.has_dispute).toBe(true);
    expect(r.items[0]?.is_test).toBe(true);
  });

  // @why 这三条是 `is_test` 过滤口径的全部（默认隐藏 / includeTest 放行 / 有 keyword 放行）。
  //      少任何一条，"测试单到底会不会出现在客服眼前"就只剩实现说了算。
  it('is_test：默认隐藏；includeTest=true 放行', async () => {
    await insertOrder({ id: 'o-1', isTest: true });
    await insertOrder({ id: 'o-2', isTest: false });
    expect((await listAdminOrders(db, { page: 1, size: 20 })).items.map((r) => r.id)).toEqual([
      'o-2',
    ]);
    expect(
      (await listAdminOrders(db, { page: 1, size: 20, includeTest: true })).items,
    ).toHaveLength(2);
  });

  it('is_test：给了 keyword 就放行（按单号救单不能撞上"查无此单"）', async () => {
    await insertOrder({ id: 'o-1', orderNo: 'NO-TEST-1', isTest: true });
    expect((await listAdminOrders(db, { page: 1, size: 20 })).items).toHaveLength(0);
    const r = await listAdminOrders(db, { page: 1, size: 20, keyword: 'NO-TEST-1' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.order_no).toBe('NO-TEST-1');
  });

  it('keyword 大小写无关；空白关键字当作没给（不是"全表命中"）', async () => {
    await insertOrder({ id: 'o-1', recipient: 'Zhang San' });
    await insertOrder({ id: 'o-2', recipient: 'Li Si' });
    expect((await listAdminOrders(db, { page: 1, size: 20, keyword: 'zhang' })).items).toHaveLength(
      1,
    );
    // @why 空串若被当成真条件，`position('' in x) > 0` 恒真 → 全表命中且没人觉得不对。
    expect((await listAdminOrders(db, { page: 1, size: 20, keyword: '   ' })).total).toBe(2);
  });

  it('分页：limit/offset 生效，total 是不受分页影响的总数', async () => {
    await insertOrder({ id: 'o-1' });
    await insertOrder({ id: 'o-2' });
    await insertOrder({ id: 'o-3' });
    const p1 = await listAdminOrders(db, { page: 1, size: 2 });
    const p2 = await listAdminOrders(db, { page: 2, size: 2 });
    expect(p1.total).toBe(3);
    expect(p2.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    // @why 断言"两页合起来不重不漏"：只断言各页长度的话，
    //      offset 算错（如忘了 -1）会让第 2 页重复第 1 页的最后一页内容却照样"绿"。
    expect([...p1.items, ...p2.items].map((r) => r.id)).toHaveLength(3);
    expect(new Set([...p1.items, ...p2.items].map((r) => r.id)).size).toBe(3);
  });

  it('findAdminOrder：存在 → 含地址与金额拆分；不存在 → null', async () => {
    await insertOrder({ id: 'o-1' });
    const o = await findAdminOrder(db, 'o-1');
    expect(o?.items_jpy).toBe(1000);
    expect(o?.shipping_jpy).toBe(500);
    expect(o?.total_jpy).toBe(1650);
    expect((o?.address_snapshot as { recipient?: string })?.recipient).toBe('Jane Doe');
    expect(await findAdminOrder(db, 'no-such')).toBeNull();
  });

  it('批量附属查询：一次取多单的 items / payments / events（不按单循环，防 N+1）', async () => {
    await insertOrder({ id: 'o-1' });
    await insertOrder({ id: 'o-2' });
    const ids = ['o-1', 'o-2'];
    const items = await listOrderItemsFor(db, ids);
    const pays = await listPaymentsFor(db, ids);
    const evs = await listEventsFor(db, ids);
    expect(items).toHaveLength(2);
    expect(pays).toHaveLength(2);
    expect(evs).toHaveLength(2);
    expect(items.map((i) => i.order_id).sort()).toEqual(['o-1', 'o-2']);
    expect(pays[0]?.provider).toBe('stripe');
    expect(evs[0]?.status).toBe('paid');
  });

  // @why 空 id 列表必须返回 [] 而不是发一条 `in ()` ——那是语法错误（文件头 @limitation 二），
  //      且报错指向 SQL 语法、真因却在调用方，是典型的误导性崩溃。
  it('批量附属查询：空 id 列表 → []（不下 SQL）', async () => {
    await expect(listOrderItemsFor(db, [])).resolves.toEqual([]);
    await expect(listPaymentsFor(db, [])).resolves.toEqual([]);
    await expect(listEventsFor(db, [])).resolves.toEqual([]);
  });
});

/**
 * D-39：`listOrderItemsFor` 读出**采购三列**（待采购清单的数据来源）。
 *
 * @why 这两条的分工与 `create-order.db.test.ts` 那三条不同：那边验"下单时落下去"，
 *      这边验"管理端读得出来"。中间隔着一层 `strOrNull`，而它的失败模式是
 *      **静默的**——`select` 漏了列时 `r.title_ja` 是 `undefined`，`strOrNull` 照样返回 `null`，
 *      于是"这一列从来没被读出来"看起来和"这单确实没记采购信息"一模一样。
 *      所以**必须有一条三列有值的用例**：只有非空值能把"漏列"和"确实是空"区分开。
 *
 * @why 空串用例（第二条）钉的是**分层边界**：仓储**忠实**返回库里的空串，
 *      把空串折叠成"未记录"是**展示层**（admin-web `purchaseLine`）的事。
 *      若仓储自己折叠，将来要区分"编辑留空"与"编辑填了又删"就没有数据了。
 */
describe('D-39：管理端读出采购快照（待采购清单）', () => {
  it('三列有值 → 原样读出（漏了 select 的列会在这里红，而不是静默变 null）', async () => {
    await insertOrder({ id: 'o-p' });
    await db`
      update order_items
         set title_ja = 'シェフナイフ', jan_code = '4900000000003', purchase_source = 'Amazon JP'
       where order_id = 'o-p'
    `;
    const items = await listOrderItemsFor(db, ['o-p']);
    expect(items).toHaveLength(1);
    expect(items[0]?.title_snapshot).toBe('商品');
    expect(items[0]?.title_ja).toBe('シェフナイフ');
    expect(items[0]?.jan_code).toBe('4900000000003');
    expect(items[0]?.purchase_source).toBe('Amazon JP');
  });

  it('库里是空串 → 读出空串（折叠成"未记录"是展示层的事，仓储不擅自改数据）', async () => {
    await insertOrder({ id: 'o-q' });
    await db`update order_items set title_ja = '', jan_code = '', purchase_source = '' where order_id = 'o-q'`;
    const items = await listOrderItemsFor(db, ['o-q']);
    expect(items[0]?.title_ja).toBe('');
    expect(items[0]?.jan_code).toBe('');
    expect(items[0]?.purchase_source).toBe('');
  });

  it('库里是 NULL → 读出 null（不是 undefined，也不是空串）', async () => {
    await insertOrder({ id: 'o-r' });
    const items = await listOrderItemsFor(db, ['o-r']);
    expect(items[0]?.title_ja).toBeNull();
    expect(items[0]?.jan_code).toBeNull();
    expect(items[0]?.purchase_source).toBeNull();
  });
});
