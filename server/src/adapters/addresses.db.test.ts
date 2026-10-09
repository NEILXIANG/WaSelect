/**
 * 职责：`adapters/addresses.ts` 的真库用例（I1-U5a，L1 层）——CRUD、归属过滤、
 *      "默认唯一"的应用层换默认与 **011 部分唯一索引**（DB 兜底）都钉在真库上。
 *
 * @why "先清后设"与唯一索引是**两层**而不是冗余：应用层两句保证正常路径语义正确，
 *      索引保证并发/绕过仓储的写入（手工 SQL、将来的管理端）也造不出两条默认。
 *      只测一层都证明不了另一层还在。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { ERROR_CODES, MAX_ADDRESSES_PER_USER } from '@waselect/shared';
import { createAddressRepo, type AddressInput, type AddressRepo } from './addresses.js';

let db: Db;
let repo: AddressRepo;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  repo = createAddressRepo(db);
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  await db`insert into users (id, openid) values ('u-1', 'o-1'), ('u-2', 'o-2')`;
});

function input(over: Partial<AddressInput> = {}): AddressInput {
  return {
    recipient: 'Jane Doe',
    phone: '+14155550123',
    line1: '1 Infinite Loop',
    line2: null,
    city: 'Cupertino',
    state: 'CA',
    postal_code: '95014',
    country: 'US',
    is_default: false,
    ...over,
  };
}

describe('每人地址条数上限（工程缺口第二轮 §6.3 G8）', () => {
  /**
   * @why 地址新增没有限流、也没有条数上限：一个账号就能写入任意多行（存储与列表接口都被拖慢），
   *      且地址簿越长，买家选错收货地址的概率越高。上限在**用户行锁内**计数，并发两次新增不能同时卡过线。
   */
  it(`🔴 已有 ${'$'}{MAX_ADDRESSES_PER_USER} 条 → 再建 40917；删一条后可再建`, async () => {
    for (let i = 0; i < MAX_ADDRESSES_PER_USER; i++) {
      await repo.create(`addr-cap-${String(i)}`, 'u-1', input());
    }
    await expect(repo.create('addr-cap-over', 'u-1', input())).rejects.toMatchObject({
      code: 40917,
    });
    // 文案里写死的上限必须与常量一致（shared errors.ts 的 message 不能插值）
    expect(ERROR_CODES[40917].message).toContain(String(MAX_ADDRESSES_PER_USER));
    await db`delete from addresses where id = 'addr-cap-0'`;
    await expect(repo.create('addr-cap-again', 'u-1', input())).resolves.toMatchObject({
      id: 'addr-cap-again',
    });
  });

  it('🔴 并发两次新增卡在线上（已有 上限−1 条）→ 只成功一次', async () => {
    for (let i = 0; i < MAX_ADDRESSES_PER_USER - 1; i++) {
      await repo.create(`addr-race-${String(i)}`, 'u-1', input());
    }
    const results = await Promise.allSettled([
      repo.create('addr-race-a', 'u-1', input()),
      repo.create('addr-race-b', 'u-1', input()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [c] = await db`select count(*)::int as n from addresses where user_id = 'u-1'`;
    expect(c?.['n']).toBe(MAX_ADDRESSES_PER_USER);
  });
});

describe('create / listByUser', () => {
  it('新增后可读回；列表只含本人（u-2 的地址不串）', async () => {
    await repo.create('a-1', 'u-1', input());
    await repo.create('a-2', 'u-2', input({ recipient: 'Bob Smith' }));
    const mine = await repo.listByUser('u-1');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 'a-1', recipient: 'Jane Doe', country: 'US' });
  });

  it('设默认时清掉旧默认（先清后设，任何时刻最多一条）', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input({ recipient: 'Bob Smith', is_default: true }));
    const mine = await repo.listByUser('u-1');
    expect(mine.filter((a) => a.is_default).map((a) => a.id)).toEqual(['a-2']);
    // 默认排在列表最前
    expect(mine[0]?.id).toBe('a-2');
  });

  it('不设默认则旧默认不动', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input());
    const mine = await repo.listByUser('u-1');
    expect(mine.filter((a) => a.is_default).map((a) => a.id)).toEqual(['a-1']);
  });
});

describe('默认唯一的 DB 兜底（011 部分唯一索引）', () => {
  it('绕过仓储直接插两条默认 → 23505（应用层失效时也造不出两条默认）', async () => {
    await expect(
      db`
        insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, is_default)
        values ('x-1', 'u-1', 'A B', '+14155550123', '1 St', 'C', 'CA', '95014', true),
               ('x-2', 'u-1', 'A B', '+14155550123', '2 St', 'C', 'CA', '95014', true)
      `,
    ).rejects.toThrow(/23505|duplicate key/);
  });

  it('多条非默认共存合法（部分索引只管 is_default=true）', async () => {
    await repo.create('a-1', 'u-1', input());
    await repo.create('a-2', 'u-1', input());
    expect(await repo.listByUser('u-1')).toHaveLength(2);
  });
});

describe('update / remove（归属过滤进 WHERE）', () => {
  it('全量更新成功并读回新值；改成默认同样先清后设', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input());
    const row = await repo.update('a-2', 'u-1', input({ recipient: 'New Name', is_default: true }));
    expect(row?.recipient).toBe('New Name');
    const mine = await repo.listByUser('u-1');
    expect(mine.filter((a) => a.is_default).map((a) => a.id)).toEqual(['a-2']);
  });

  it('更新/删除别人的地址 → null / false（不泄露存在性）', async () => {
    await repo.create('a-1', 'u-1', input());
    expect(await repo.update('a-1', 'u-2', input({ recipient: 'Hacker' }))).toBeNull();
    expect(await repo.remove('a-1', 'u-2')).toBe(false);
    // 原值未动
    const mine = await repo.listByUser('u-1');
    expect(mine[0]?.recipient).toBe('Jane Doe');
  });

  /**
   * B23 / AJ-203：更新一个**不存在**（或已被别处删掉）的地址并勾选默认。
   *
   * @why 这条的坏法不报错也不显示：用户只看到 404「保存失败」（他会再点一次），
   *      而**他的默认地址已经被清掉了**——下次下单静默用了一个没有默认的地址列表。
   *      所以断言必须同时钉两头：① 返回 null（404 没变）；② **默认地址还在**。
   *      只断言 ① 的话，旧实现（先清后设）也全绿——那正是这个缺陷藏了这么久的原因。
   */
  it('更新不存在的地址并勾默认 → null，且**原来的默认地址不被清掉**（B23 / AJ-203）', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input());

    const row = await repo.update('a-gone', 'u-1', input({ recipient: 'Ghost', is_default: true }));
    expect(row).toBeNull();

    const mine = await repo.listByUser('u-1');
    // ② 才是本用例的重点：默认地址必须还在，且仍然是 a-1
    expect(mine.filter((a) => a.is_default).map((a) => a.id)).toEqual(['a-1']);
    expect(mine).toHaveLength(2);
  });

  it('更新别人已删掉的地址（先删后改）→ null 且默认不动（B23 的真实触发顺序）', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input());
    // 另一个标签页/设备把它删了
    expect(await repo.remove('a-2', 'u-1')).toBe(true);

    const row = await repo.update(
      'a-2',
      'u-1',
      input({ recipient: 'Stale Tab', is_default: true }),
    );
    expect(row).toBeNull();
    const mine = await repo.listByUser('u-1');
    expect(mine.filter((a) => a.is_default).map((a) => a.id)).toEqual(['a-1']);
  });

  it('删除返回是否真删了；删除默认不自动提升其它', async () => {
    await repo.create('a-1', 'u-1', input({ is_default: true }));
    await repo.create('a-2', 'u-1', input());
    expect(await repo.remove('a-1', 'u-1')).toBe(true);
    expect(await repo.remove('a-1', 'u-1')).toBe(false);
    const mine = await repo.listByUser('u-1');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.is_default).toBe(false); // @limitation 二：不自动提升
  });
});

/**
 * 同一用户并发"新建并设为默认"（S-03）：两条都要成功，且恰好一条默认。
 * @why READ COMMITTED 下两个事务都先清旧默认；后者在旧默认行的锁上等，前者提交后旧行已不是默认，
 *      后者跳过它、照常插入一条默认，撞上前者刚插的默认行 → 23505 → 500（而其中一条其实已保存）。
 *      连点两次保存、或网络重试，都会这样。
 */
describe('并发设默认（S-03）', () => {
  it('🔴 已有默认地址时，两个"新建并设默认"并发到达 → 都成功，恰好 1 条默认', async () => {
    await repo.create('a-0', 'u-1', input({ is_default: true }));
    let locked: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    // 先持有旧默认行的锁，让两个建址事务都卡在"清默认"那一步，再一起放行
    const holder = db.begin(async (tx) => {
      await tx`select id from addresses where id = 'a-0' for update`;
      locked();
      await new Promise((r) => setTimeout(r, 300));
    });
    await ready;
    const results = await Promise.allSettled([
      repo.create('a-1', 'u-1', input({ is_default: true })),
      repo.create('a-2', 'u-1', input({ recipient: 'Bob Smith', is_default: true })),
    ]);
    await holder;
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const defaults = await db`select id from addresses where user_id = 'u-1' and is_default`;
    expect(defaults).toHaveLength(1);
  });

  /**
   * 🔴 P1-2：`update`（把**当前默认行**再设为默认）与 `create`（新建并设默认）并发——旧锁序会死锁。
   * @why 旧实现 update 先锁地址行、后锁 users 行；create 先锁 users 行、清默认时再锁旧默认地址行——AB/BA 反转。
   *      只有 update 的目标**正是**旧默认行时两边才会争同一把地址行锁，才可能成环；
   *      目标是非默认行（WorkBuddy 原补丁的写法）结构上成不了环，换回旧锁序也照样绿（2026-10-08 实测）。
   * @why 用"等对方进入锁等待"控制先后，而不是 sleep 碰运气：挡片持住旧默认行 → update 先排进等待 →
   *      create 拿到 users 行后也排进等待 → 放开挡片。旧锁序下 update 拿到地址行后去等 users、create 等地址行 → 40P01；
   *      新锁序下 update 一开始就先拿 users，create 在 users 上排队，放开后顺序完成。
   * @measured 2026-10-08 临时探针：旧锁序 `["ok","ERR 40P01 deadlock detected"]`；新锁序 `["ok","ok"]`。
   */
  it('🔴 改默认（update 目标 = 旧默认行）与新建并设默认（create）并发：零 40P01，恰好 1 条默认', async () => {
    await repo.create('a-0', 'u-1', input({ is_default: true }));
    /** 本库里正在等行锁的会话数（只看当前测试库，不受并行 worker 的其它库影响）。 */
    const lockWaiters = async (): Promise<number> => {
      const r = await db`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
      `;
      return Number(r[0]?.n ?? 0);
    };
    const waitFor = async (n: number): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        if ((await lockWaiters()) >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`等不到 ${n} 个锁等待者`);
    };
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (held = r));
    const blocker = db.begin(async (tx) => {
      await tx`select id from addresses where id = 'a-0' for update`;
      held();
      await gate;
    });
    await holding;
    const outcome = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'ok',
        (e: unknown) => `ERR ${String((e as { code?: unknown }).code ?? '')}`,
      );
    const upd = outcome(repo.update('a-0', 'u-1', input({ is_default: true })));
    await waitFor(1);
    const crt = outcome(
      repo.create('a-new', 'u-1', input({ recipient: 'Carol Smith', is_default: true })),
    );
    await waitFor(2);
    release();
    await blocker;
    expect(await Promise.all([upd, crt])).toEqual(['ok', 'ok']);
    const defaults = await db`select id from addresses where user_id = 'u-1' and is_default`;
    expect(defaults).toHaveLength(1);
  });
});
