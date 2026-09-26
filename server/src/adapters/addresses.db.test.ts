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
