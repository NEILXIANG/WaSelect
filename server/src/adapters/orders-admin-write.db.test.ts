/**
 * 职责：`adapters/orders-admin.ts` **写路径**（发货 / 退款 / 改址）的真库用例（I2 U-B2b）。
 *
 * @why 与读路径**分成两个测试文件**：写路径每个用例都要先 `begin` 一个事务
 *      （`lockAdminOrder` 的 `for update` 在事务外等于没锁），而读路径的用例全是无事务的。
 *      混在一个文件里，读用例会"顺便"跑在有事务的连接上，
 *      于是"这个查询到底有没有事务要求"再也没人说得清。
 *
 * @why 每个写函数都验 **0 行命中的那一档**（状态已被抢先迁走 → false，不是抛错）：
 *      这是它们唯一的"静默"分支——返回 false 而调用方当真，会表现为
 *      "点了发货、钱没动、也没报错"。false 与抛错的区分必须由测试钉住。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db, withTransaction } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import {
  findRefundablePayment,
  findRefundProgress,
  lockAdminOrder,
  markRefunded,
  markRefunding,
  markShipped,
  releaseDisputeHold,
  recordRefundFailed,
  recordRefundPending,
  updateAddressSnapshot,
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

/** 插一张订单 + 一条已成功的支付行（退款路径的起点）。 */
async function seedPaidOrder(id: string, status = 'paid'): Promise<void> {
  await db`
    insert into users (id, openid) values (${`u-${id}`}, ${`o-${id}`})
      on conflict (id) do nothing
  `;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, origin_country)
    values (${`p-${id}`}, '商品', 'daily', 1000, 500, 'JP')
      on conflict (id) do nothing
  `;
  await db`
    insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                        total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version,
                        has_dispute, expires_at)
    values (${id}, ${`NO-${id}`}, ${`u-${id}`}, ${status}, 1000, 500, 150, 1650, 500,
            ${db.json({ USD: 0.0067 } as never)},
            ${db.json({ id: 'a-1', recipient: 'Jane Doe', line1: '1 Infinite Loop' } as never)},
            'TOS-TEST-1', false, now() + interval '30 minutes')
  `;
  await db`
    insert into payments (id, order_id, provider, status, charge_currency, charge_amount)
    values (${`pay-${id}`}, ${id}, 'stripe', ${status === 'paid' ? 'succeeded' : 'initiated'},
            'USD', 1100)
  `;
}

describe('orders-admin 写路径（I2 U-B2b）', () => {
  it('lockAdminOrder：持锁读出行；不存在 → null', async () => {
    await seedPaidOrder('o-1');
    await withTransaction(db, async (tx) => {
      const row = await lockAdminOrder(tx, 'o-1');
      expect(row?.status).toBe('paid');
      expect(row?.has_dispute).toBe(false);
      expect(row?.total_jpy).toBe(1650);
      expect(row?.is_test).toBe(false); // 发货闸门要它（审核期测试单不发货，AJ-179）
      expect(await lockAdminOrder(tx, 'no-such')).toBeNull();
    });
  });

  it('markShipped：paid → shipped，落 carrier / tracking_no / shipped_at 与事件', async () => {
    await seedPaidOrder('o-1');
    const at = new Date('2026-09-27T10:00:00Z');
    await withTransaction(db, async (tx) => {
      expect(await markShipped(tx, 'o-1', 'JPPOST', 'TRACK-1', at, 'admin:u-admin')).toBe(true);
    });
    const rows =
      await db`select status, carrier, tracking_no, shipped_at from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('shipped');
    expect(String(rows[0]?.carrier)).toBe('JPPOST');
    expect(String(rows[0]?.tracking_no)).toBe('TRACK-1');
    expect(rows[0]?.shipped_at).not.toBeNull();
    const evs = await db`select status, note, actor from order_events where order_id = 'o-1'`;
    expect(String(evs[0]?.status)).toBe('shipped');
    expect(String(evs[0]?.note)).toBe('JPPOST / TRACK-1');
    // 一致性审计 C3（AJ-176）：技术文档 actor 口径 `admin:<id>`——admin_audit 未落地前这是"谁发的货"的唯一留痕
    expect(String(evs[0]?.actor)).toBe('admin:u-admin');
  });

  it('markShipped：状态已被抢先迁走 → false 且不写事件（0 行命中不是错误）', async () => {
    await seedPaidOrder('o-1', 'shipped');
    await withTransaction(db, async (tx) => {
      expect(await markShipped(tx, 'o-1', 'JPPOST', 'TRACK-1', new Date(), 'admin:u-admin')).toBe(
        false,
      );
    });
    const evs = await db`select count(*)::int as n from order_events where order_id = 'o-1'`;
    expect(Number(evs[0]?.n)).toBe(0);
  });

  it('findRefundablePayment：只认 succeeded 行；没有 → null（没付过的钱无从退起）', async () => {
    await seedPaidOrder('o-1');
    const p = await findRefundablePayment(db, 'o-1');
    expect(p?.provider).toBe('stripe');
    // 原币退款的金额来源：charge_currency / charge_amount，不是 total_jpy
    expect(p?.charge_currency).toBe('USD');
    expect(p?.charge_amount).toBe(1100);

    await seedPaidOrder('o-2', 'created');
    expect(await findRefundablePayment(db, 'o-2')).toBeNull();
  });

  /**
   * B1b / AJ-194：`has_dispute` 必须为 true 才解除。
   * @why 命中 0 行返回 false（而不是"反正目标是 false 就算成功"）——调用方据此转 40902。
   *      "解除一个本来就没锁的限制"若算成功，运营点错单号时会以为自己解开了某张单。
   */
  it('releaseDisputeHold：已锁 → true 并记事件；本来就没锁 → false（不写事件）', async () => {
    await seedPaidOrder('o-1');
    await db`update orders set has_dispute = true where id = 'o-1'`;
    await seedPaidOrder('o-2'); // has_dispute 默认 false

    await withTransaction(db, async (tx) => {
      expect(await releaseDisputeHold(tx, 'o-1', '回调丢失', new Date(), 'admin:u-x')).toBe(true);
      expect(await releaseDisputeHold(tx, 'o-2', '试试', new Date(), 'admin:u-x')).toBe(false);
    });
    expect((await db`select has_dispute from orders where id = 'o-1'`)[0]?.has_dispute).toBe(false);
    const evs =
      await db`select note, actor, status from order_events where order_id = 'o-1' and status = 'dispute_released'`;
    expect(evs).toHaveLength(1);
    expect(String(evs[0]?.note)).toBe('回调丢失');
    expect(String(evs[0]?.actor)).toBe('admin:u-x');
    // 🔴 没锁的那张单一个事件都没写（假成功会留下一条说不清的审计）
    expect(await db`select 1 from order_events where order_id = 'o-2'`).toHaveLength(0);
  });

  it('markRefunding：paid|shipped|delivered → refunding，事件带原因', async () => {
    for (const from of ['paid', 'shipped', 'delivered']) {
      const id = `o-${from}`;
      await seedPaidOrder(id, from);
      await withTransaction(db, async (tx) => {
        expect(await markRefunding(tx, id, '缺货', new Date(), 'admin:u-admin')).toBe(true);
      });
    }
    const rows = await db`select id, status from orders order by id`;
    expect(rows.map((r) => String(r.status))).toEqual(['refunding', 'refunding', 'refunding']);
    const evs = await db`select note, actor from order_events where order_id = 'o-paid'`;
    expect(String(evs[0]?.note)).toBe('缺货');
    expect(String(evs[0]?.actor)).toBe('admin:u-admin');
  });

  it('markRefunding：cancelled / expired 带 late_paid 凭据才迁（SQL 层最后一道，1-5）', async () => {
    for (const from of ['cancelled', 'expired']) {
      const id = `o-${from}`;
      await seedPaidOrder(id, from);
      await db`insert into order_events (order_id, status, note, actor)
               values (${id}, 'late_paid', 'cs_test_late', 'provider:stripe')`;
      await withTransaction(db, async (tx) => {
        expect(await markRefunding(tx, id, '迟到付款', new Date(), 'admin:u-admin')).toBe(true);
      });
    }
    // 凭据只属于自己那一单：别的单有凭据不放行本单
    await seedPaidOrder('o-other', 'expired');
    await withTransaction(db, async (tx) => {
      expect(await markRefunding(tx, 'o-other', 'x', new Date(), 'admin:u-admin')).toBe(false);
    });
  });

  it('markRefunding：cancelled / expired（无凭据）/ refunding 一律不迁（false）', async () => {
    for (const from of ['cancelled', 'expired', 'refunding']) {
      const id = `o-${from}`;
      await seedPaidOrder(id, from);
      await withTransaction(db, async (tx) => {
        expect(await markRefunding(tx, id, 'x', new Date(), 'admin:u-admin')).toBe(false);
      });
    }
  });

  it('markRefunded：refunding → refunded，payment 行同步标 refunded，事件留机构退款号', async () => {
    await seedPaidOrder('o-1', 'refunding');
    await withTransaction(db, async (tx) => {
      expect(
        await markRefunded(tx, 'o-1', 'pay-o-1', 're_stripe_1', new Date(), 'admin:u-admin'),
      ).toBe(true);
    });
    const o = await db`select status, refunded_at from orders where id = 'o-1'`;
    expect(String(o[0]?.status)).toBe('refunded');
    expect(o[0]?.refunded_at).not.toBeNull();
    const p = await db`select status from payments where id = 'pay-o-1'`;
    expect(String(p[0]?.status)).toBe('refunded');
    const evs = await db`select status, note, actor from order_events where order_id = 'o-1'`;
    expect(String(evs[0]?.status)).toBe('refunded');
    expect(String(evs[0]?.note)).toBe('re_stripe_1');
    expect(String(evs[0]?.actor)).toBe('admin:u-admin');
  });

  it('markRefunded：重复提交 → false（第二次不再写事件，退款不会记两笔）', async () => {
    await seedPaidOrder('o-1', 'refunding');
    const at = new Date();
    await withTransaction(db, async (tx) => {
      expect(await markRefunded(tx, 'o-1', 'pay-o-1', 're_1', at, 'admin:u-admin')).toBe(true);
      expect(await markRefunded(tx, 'o-1', 'pay-o-1', 're_1', at, 'admin:u-admin')).toBe(false);
    });
    const evs = await db`select count(*)::int as n from order_events where order_id = 'o-1'`;
    expect(Number(evs[0]?.n)).toBe(1);
  });

  it('findRefundProgress（F-03）：最新一条是 pending → 带出单号；确认失败只数 provider_failed:*，不数 provider_error', async () => {
    await seedPaidOrder('o-1', 'refunding');
    const at = new Date('2026-09-29T01:00:00Z');
    expect(await findRefundProgress(db, 'o-1')).toEqual({ pendingRef: null, confirmedFailures: 0 });

    await recordRefundFailed(db, 'o-1', 'provider_error', 'admin:u-a', at); // 结果未知 ≠ 确认失败
    expect(await findRefundProgress(db, 'o-1')).toEqual({ pendingRef: null, confirmedFailures: 0 });

    await recordRefundPending(db, 'o-1', 're_A', 'admin:u-a', at);
    expect(await findRefundProgress(db, 'o-1')).toEqual({
      pendingRef: 're_A',
      confirmedFailures: 0,
    });

    // 同一时刻（at 相同）写入的后一条才是"最新"：按插入顺序判定，不按业务时间
    await recordRefundFailed(db, 'o-1', 'provider_failed:re_A', 'admin:u-a', at);
    expect(await findRefundProgress(db, 'o-1')).toEqual({ pendingRef: null, confirmedFailures: 1 });

    await recordRefundPending(db, 'o-1', 're_B', 'admin:u-a', at);
    expect(await findRefundProgress(db, 'o-1')).toEqual({
      pendingRef: 're_B',
      confirmedFailures: 1,
    });
    const ev =
      await db`select actor from order_events where order_id = 'o-1' and status = 'refund_pending'`;
    expect(ev.map((r) => r['actor'])).toEqual(['admin:u-a', 'admin:u-a']);
  });

  it('🔴 同一把退款单号的失败**只算一次**（OPS3-06：并发双击会写两条 provider_failed:re_1）', async () => {
    await seedPaidOrder('o-1', 'refunding');
    const at = new Date('2026-09-29T01:00:00Z');
    await recordRefundFailed(db, 'o-1', 'provider_failed:re_1', 'admin:u-a', at);
    await recordRefundFailed(db, 'o-1', 'provider_failed:re_1', 'admin:u-b', at); // 并发的第二次
    // 按事件行数会得 2 → 下一次换成第 3 把幂等键，而 KD-4 要求"结果未知"时沿用同一把
    expect((await findRefundProgress(db, 'o-1')).confirmedFailures).toBe(1);

    await recordRefundFailed(db, 'o-1', 'provider_failed:re_2', 'admin:u-a', at); // 换了单号才算新一次
    expect((await findRefundProgress(db, 'o-1')).confirmedFailures).toBe(2);
  });

  it('updateAddressSnapshot：重写快照 + 事件用伪状态 address_changed，**状态不变**', async () => {
    await seedPaidOrder('o-1');
    const next = { id: 'a-2', recipient: 'SAN ZHANG', line1: '2 Main St' };
    await withTransaction(db, async (tx) => {
      // AJ-455：返回归档号（路由写进审计），不再是 boolean
      expect(
        typeof (await updateAddressSnapshot(tx, 'o-1', next as never, 'admin:u-9', new Date())),
      ).toBe('number');
    });
    const rows = await db`select status, address_snapshot from orders where id = 'o-1'`;
    expect(String(rows[0]?.status)).toBe('paid');
    expect((rows[0]?.address_snapshot as { recipient?: string })?.recipient).toBe('SAN ZHANG');
    const evs = await db`select status, actor from order_events where order_id = 'o-1'`;
    expect(String(evs[0]?.status)).toBe('address_changed');
    expect(String(evs[0]?.actor)).toBe('admin:u-9');
  });

  /**
   * B12 / AJ-208：改址后**原地址必须还能查到**。
   * @why 缺了它，"盗号 → 联系客服改址 → 货发给攻击者 → 真买家以未收到货拒付"这条链
   *      在库里**查无实据**：`address_snapshot` 已被整体覆盖，拒付应诉时拿不出原地址。
   * @why 断言必须钉**内容**而不是"note 非空"：固定文案同样满足非空，
   *      而它恰恰答不出"改之前是什么"（§2 第 49 条：只验存在性是最容易假绿的一类断言）。
   * @changed AJ-293（2026-10-01）：旧地址**不再**全文写进 `order_events.note`——
   *      那张表挂 append-only，写进去就永久锁死，把 AJ-292 的匿名化出口整个堵死。
   *      改为归档进 `order_address_history`，note 只留归档号。
   *      取证链一步不变（按号回查得到完整旧地址），但这部分 PII 从此可匿名化 / 可删除。
   */
  it('updateAddressSnapshot：改前地址归档进 order_address_history，note 只留归档号（B12 / AJ-293）', async () => {
    await seedPaidOrder('o-1');
    const oldSnap = (await db`select address_snapshot from orders where id = 'o-1'`)[0]?.[
      'address_snapshot'
    ];
    const next = { id: 'a-2', recipient: 'SAN ZHANG', line1: '2 Main St' };
    await withTransaction(db, async (tx) => {
      // AJ-455：返回归档号（路由写进审计），不再是 boolean
      expect(
        typeof (await updateAddressSnapshot(tx, 'o-1', next as never, 'admin:u-9', new Date())),
      ).toBe('number');
    });
    const evs =
      await db`select note from order_events where order_id = 'o-1' and status = 'address_changed'`;
    expect(evs).toHaveLength(1);
    const note = String(evs[0]?.['note']);

    // ① note 本身不再带 PII——AJ-292 的目的就是让旧地址别再进这张删不掉的表
    for (const leak of ['Jane Doe', 'Infinite Loop', 'a-1']) {
      expect(note, `note 里不该出现旧地址的片段：${leak}`).not.toContain(leak);
    }
    expect(note).toContain('改址');

    // ② 按 note 里的归档号**回查**得到完整的改前地址（取证链不变）
    //    @why 写入点现在分裂成两处（note + 历史表），只断言"insert 成功了"会漏掉
    //    "只插了一处"这种写法——而取证链断掉是**静默**的（AJ-293 反向风险第一条）。
    const archiveMatch = note.match(/#(\d+)/);
    expect(archiveMatch?.[1], 'note 里必须带归档号，否则取证无从查起').toBeDefined();
    // @why toBeDefined() 断言**不会**帮 TS 收窄类型（vitest 不类型检查，只有 tsc 会拦），
    //      这里必须显式收敛成 string，否则下面 db`...` 的重载匹配不上。
    const archiveId = String(archiveMatch?.[1]);
    const hist = await db`select snapshot from order_address_history where id = ${archiveId}`;
    expect(hist).toHaveLength(1);
    expect(hist[0]?.['snapshot']).toEqual(oldSnap);
    expect((hist[0]?.['snapshot'] as { recipient?: string }).recipient).not.toBe('SAN ZHANG');

    // ③ 新地址确实生效——只断言"有旧值"的话，把写入方向写反（新旧互换）也全绿
    const now = await db`select address_snapshot from orders where id = 'o-1'`;
    expect((now[0]?.['address_snapshot'] as { recipient?: string }).recipient).toBe('SAN ZHANG');
  });

  it('连续改两次：每次归档的都是**当时**的旧地址（不是第一次的、也不是最新快照）', async () => {
    await seedPaidOrder('o-1');
    const first = (await db`select address_snapshot from orders where id = 'o-1'`)[0]?.[
      'address_snapshot'
    ];
    await withTransaction(db, async (tx) => {
      await updateAddressSnapshot(
        tx,
        'o-1',
        { recipient: 'MID' } as never,
        'admin:u-9',
        new Date(),
      );
      await updateAddressSnapshot(
        tx,
        'o-1',
        { recipient: 'NEW' } as never,
        'admin:u-9',
        new Date(),
      );
    });
    const hist =
      await db`select snapshot from order_address_history where order_id = 'o-1' order by id`;
    expect(hist).toHaveLength(2);
    expect(hist[0]?.['snapshot']).toEqual(first);
    expect(hist[1]?.['snapshot']).toEqual({ recipient: 'MID' });
  });

  /**
   * AJ-293 的**目的本身**：这张表必须能被改、能被删。
   *
   * @why 断言"可以 DELETE"而不是只断言"表存在"：本表存在的全部理由就是**不挂** append-only。
   *      将来谁为了"审计更严"给它补一个触发器，上面几条用例**全部照绿**——
   *      旧地址又开始永久锁死，而没有任何东西会响。这一条是唯一的哨兵。
   * @why 顺带验 UPDATE（匿名化的形态）：真实删除请求之外，更常见的处置是
   *      "抹掉地址内容、保留'改过址'这个事实"，所以两种都要能走通。
   */
  it('order_address_history 可以 UPDATE / DELETE（不挂 append-only）：匿名化出口不能被堵回去（AJ-293）', async () => {
    await seedPaidOrder('o-1');
    await withTransaction(db, async (tx) => {
      await updateAddressSnapshot(
        tx,
        'o-1',
        { recipient: 'NEW' } as never,
        'admin:u-9',
        new Date(),
      );
    });
    const rows = await db`select id from order_address_history where order_id = 'o-1'`;
    expect(rows).toHaveLength(1);
    // 匿名化：抹掉内容（若挂了触发器，这一步就会 42501）
    await db`update order_address_history set snapshot = ${db.json({ redacted: true } as never)} where id = ${rows[0]?.['id']}`;
    expect(
      (await db`select snapshot from order_address_history where id = ${rows[0]?.['id']}`)[0]?.[
        'snapshot'
      ],
    ).toEqual({ redacted: true });
    // 删除：兑现删除请求
    await db`delete from order_address_history where id = ${rows[0]?.['id']}`;
    expect(await db`select id from order_address_history where order_id = 'o-1'`).toHaveLength(0);
  });

  it('updateAddressSnapshot：已发货 → false，快照保持原样', async () => {
    await seedPaidOrder('o-1', 'shipped');
    await withTransaction(db, async (tx) => {
      expect(
        await updateAddressSnapshot(tx, 'o-1', { recipient: 'NEW' } as never, 'admin', new Date()),
      ).toBe(false);
    });
    const rows = await db`select address_snapshot from orders where id = 'o-1'`;
    expect((rows[0]?.address_snapshot as { recipient?: string })?.recipient).toBe('Jane Doe');
  });
});
