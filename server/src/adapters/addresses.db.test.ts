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
});
