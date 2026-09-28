/**
 * 职责：`adapters/risk-admin.ts` 的真库用例（I2 U-E2）——拒付列表与拉黑。
 *
 * @why 拉黑的三条分支（首次 / 已拉黑 / 不存在 / 是管理员）必须**逐条查库**验：
 *      它们的差别全在副作用上（`blocked_at` 有没有被刷新、`token_ver` 有没有再 +1），
 *      而返回值只有四个 kind——只看返回值的话，"重复拉黑把首次封禁时间改掉"
 *      这种实现**完全看不出来**（AJ-157 ④：那会让审计答不出"什么时候封的"）。
 *
 * @why 拉黑的效果用 `createIdentityCheck` **换一个读取方**再读一次（而不是只查 `users`）：
 *      断言"我自己写进去的值"是自证（§2 第 21 条）。真正的消费者是鉴权那个端口，
 *      它读的是同一行的**另两条列**（`blocked_at` + `token_ver`），
 *      由它来读才能证明"改完之后鉴权真的会拦住这个人"。
 *
 * @limitation 拒付行是**裸 SQL** 造的：`payments.dispute_*` 目前**没有任何服务端写入方**
 *      （Stripe dispute 事件落地尚未实现），没有"走真函数"这条路可走。
 *      这与 mark-paid 用例"必须走 recordPaymentIntent"相反——那里有写入方，这里没有。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createIdentityCheck } from './identity.js';
import { createRiskAdminRepo, type DisputeRow } from './risk-admin.js';

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
  await db`insert into users (id, openid) values ('u-1', 'o-1')`;
});

/** 造一单 + 一笔支付；`dispute` 为 undefined 时表示"没有拒付"。 */
async function seedPayment(
  payId: string,
  orderId: string,
  dispute?: {
    id: string;
    status: string | null;
    amount: number | null;
    currency?: string;
    openedAt?: string | null;
    closedAt?: string | null;
  },
): Promise<void> {
  await db`insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                               total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
           values (${orderId}, ${`W-${orderId}`}, 'u-1', 'paid', 1000, 0, 0, 1000, 500,
                   '{}'::jsonb, '{}'::jsonb, 'T', now() + interval '30 minutes')`;
  await db`insert into payments (id, order_id, provider, status, charge_currency, charge_amount,
                                 dispute_id, dispute_status, dispute_amount,
                                 dispute_opened_at, dispute_closed_at)
           values (${payId}, ${orderId}, 'stripe', 'succeeded', ${dispute?.currency ?? 'USD'},
                   ${dispute?.amount ?? 1000}, ${dispute?.id ?? null},
                   ${dispute?.status ?? null}, ${dispute?.amount ?? null},
                   ${dispute?.openedAt ?? null}, ${dispute?.closedAt ?? null})`;
}

const ids = (rows: DisputeRow[]): string[] => rows.map((r) => r.disputeId);

describe('listDisputes', () => {
  it('空表 → []', async () => {
    expect(await createRiskAdminRepo(db).listDisputes()).toEqual([]);
  });

  it('🔴 只有带 dispute_id 的支付行会出现（无拒付的支付行不出现）', async () => {
    await seedPayment('p-1', 'o-1');
    await seedPayment('p-2', 'o-2', {
      id: 'dp_1',
      status: 'open',
      amount: 4200,
      openedAt: '2026-09-01T00:00:00Z',
    });
    const rows = await createRiskAdminRepo(db).listDisputes();
    expect(ids(rows)).toEqual(['dp_1']);
  });

  it('🔴 筛状态时同样不出现无拒付的支付行（判据只有一份，但两条路径都要验）', async () => {
    // ⚠️ 这条是被缺陷注入逼出来的：初版把 `dispute_id is not null` 写了两份
    //    （"过滤/不过滤"各一条 SQL），注掉过滤那份时**用例全绿**——
    //    因为当时只测了"不过滤"这条路径。改单查询之后，这条用例两条路径都走。
    await seedPayment('p-1', 'o-1'); // 无拒付
    await seedPayment('p-2', 'o-2', { id: 'dp-1', status: 'open', amount: 1 });
    const repo = createRiskAdminRepo(db);
    expect(ids(await repo.listDisputes())).toEqual(['dp-1']);
    expect(ids(await repo.listDisputes('open'))).toEqual(['dp-1']);
  });

  it('status 过滤：三个状态各取各的', async () => {
    await seedPayment('p-1', 'o-1', { id: 'dp-open', status: 'open', amount: 100 });
    await seedPayment('p-2', 'o-2', { id: 'dp-won', status: 'won', amount: 200 });
    await seedPayment('p-3', 'o-3', { id: 'dp-lost', status: 'lost', amount: 300 });
    await seedPayment('p-4', 'o-4', { id: 'dp-null', status: null, amount: null });
    const repo = createRiskAdminRepo(db);
    expect(ids(await repo.listDisputes('open'))).toEqual(['dp-open']);
    expect(ids(await repo.listDisputes('won'))).toEqual(['dp-won']);
    expect(ids(await repo.listDisputes('lost'))).toEqual(['dp-lost']);
    // 不传 = 不过滤（含 status 为 null 的行：落了一半的拒付也要看得见）
    expect((await repo.listDisputes()).map((r) => r.disputeId).sort()).toEqual([
      'dp-lost',
      'dp-null',
      'dp-open',
      'dp-won',
    ]);
  });

  it('排序：开案时间倒序，NULL 排最后（新的在前）', async () => {
    await seedPayment('p-1', 'o-1', {
      id: 'dp-old',
      status: 'open',
      amount: 1,
      openedAt: '2026-01-01T00:00:00Z',
    });
    await seedPayment('p-2', 'o-2', { id: 'dp-null', status: 'open', amount: 1, openedAt: null });
    await seedPayment('p-3', 'o-3', {
      id: 'dp-new',
      status: 'open',
      amount: 1,
      openedAt: '2026-09-01T00:00:00Z',
    });
    expect(ids(await createRiskAdminRepo(db).listDisputes())).toEqual([
      'dp-new',
      'dp-old',
      'dp-null',
    ]);
  });

  it('字段带出：order_no 联出来、金额是**原币**、closed_at 带出', async () => {
    await seedPayment('p-1', 'o-1', {
      id: 'dp-1',
      status: 'open',
      amount: 4200,
      currency: 'USD',
      openedAt: '2026-09-01T00:00:00Z',
      closedAt: '2026-09-05T00:00:00Z',
    });
    const r = (await createRiskAdminRepo(db).listDisputes())[0];
    expect(r?.orderNo).toBe('W-o-1');
    expect(r?.paymentId).toBe('p-1');
    expect(r?.chargeCurrency).toBe('USD');
    expect(r?.disputeAmount).toBe(4200);
    expect(r?.openedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(r?.closedAt?.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    // 未结案时 closed_at 必须是 null（不是"空字符串/1970"之类）
    await seedPayment('p-2', 'o-2', {
      id: 'dp-2',
      status: 'open',
      amount: 1,
      openedAt: '2026-09-02T00:00:00Z',
      closedAt: null,
    });
    const open = (await createRiskAdminRepo(db).listDisputes('open')).find(
      (x) => x.disputeId === 'dp-2',
    );
    expect(open?.closedAt).toBeNull();
  });
});

describe('blockUser', () => {
  it('首次拉黑：blocked + already=false；库里 blocked_at 非空且 token_ver +1', async () => {
    const before = await db`select token_ver from users where id = 'u-1'`;
    const out = await createRiskAdminRepo(db).blockUser('u-1');
    expect(out).toEqual({ kind: 'blocked', already: false });
    const after = await db`select token_ver, blocked_at from users where id = 'u-1'`;
    expect(Number(after[0]?.['token_ver'])).toBe(Number(before[0]?.['token_ver']) + 1);
    expect(after[0]?.['blocked_at']).not.toBeNull();
  });

  it('🔴 重复拉黑：already=true，且**不刷新 blocked_at、不再 +1 token_ver**（幂等）', async () => {
    const repo = createRiskAdminRepo(db);
    await repo.blockUser('u-1');
    const mid = await db`select token_ver, blocked_at from users where id = 'u-1'`;
    const out = await repo.blockUser('u-1');
    expect(out).toEqual({ kind: 'blocked', already: true });
    const end = await db`select token_ver, blocked_at from users where id = 'u-1'`;
    // 时间必须**严格相等**：刷新了就答不出"最初是什么时候封的"。
    // ⚠️ 必须比 `getTime()`（毫秒）——`String(Date)` / `toLocaleString()` **不带毫秒**，
    //    两次相差几十毫秒的 now() 会落在同一秒里从而"看起来相等"：
    //    缺陷注入 ⑥（`coalesce(blocked_at, now())` → `now()`）当初就是这么全绿的（§2 第 45 条）。
    expect((end[0]?.['blocked_at'] as Date | null)?.getTime()).toBe(
      (mid[0]?.['blocked_at'] as Date | null)?.getTime(),
    );
    expect(Number(end[0]?.['token_ver'])).toBe(Number(mid[0]?.['token_ver']));
  });

  it('不存在的用户 → not_found；且不产生任何副作用', async () => {
    expect(await createRiskAdminRepo(db).blockUser('nope')).toEqual({ kind: 'not_found' });
    const n = await db`select count(*)::int as n from users`;
    expect(Number(n[0]?.['n'])).toBe(1);
  });

  it('🔴 管理员 → is_admin 且库里**一点没动**（拉黑管理员 = 把自己锁在门外）', async () => {
    await db`update users set is_admin = true where id = 'u-1'`;
    const out = await createRiskAdminRepo(db).blockUser('u-1');
    expect(out).toEqual({ kind: 'is_admin' });
    const row = await db`select blocked_at, token_ver from users where id = 'u-1'`;
    expect(row[0]?.['blocked_at']).toBeNull();
    expect(Number(row[0]?.['token_ver'])).toBe(1);
  });

  it('拉黑之后**换一个读取方**（identity 端口）读到 blockedAt 非空', async () => {
    // §2 第 21 条：只查 users 表等于断言"我自己写进去的值"
    await createRiskAdminRepo(db).blockUser('u-1');
    const rec = await createIdentityCheck(db).load('u-1');
    expect(rec).not.toBeNull();
    expect(rec?.blockedAt).not.toBeNull();
  });
});
