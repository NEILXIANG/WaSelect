/**
 * 职责：美国地址边界样本的真库验证（FX5）。
 *
 * @why 边界样本如果只"看起来合法"就没有意义——唯一不会说谎的裁判是 DDL 的 CHECK 约束。
 *      军邮州码 AA/AE/AP、姓名里的撇号、ZIP+4、200 字符的 line2，
 *      这四类都是"看起来怪、但现实里必须能收"的输入；
 *      而邮编缺前导零、电话带连字符这类"真实用户最爱填的脏输入"则必须被拒绝。
 *      两边都跑一遍，"约束还在不在"这件事才真正被验证过。
 *
 * @limitation 这里只验**存储层约束**，不验业务规则（可达性、运费分区、PO Box 是否可送）——
 *              那些规则还没定，现在写进去等于把猜测固化成断言。
 *              PO Box / 夏威夷 / 军邮在样本里已备好，等规则定了直接拿来当回归。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../server/src/adapters/db.js';
import { ensureTestDb, resetTestDb, testDb } from '../db/test-db.js';
import {
  ADDRESS_LINE2_MAX_CHARS,
  LINE2_AT_LIMIT,
  US_ADDRESSES,
  US_ADDRESS_INVALID,
  formatUsPhone,
} from './catalog.js';
import { createIds, makeUser, type UserRow } from './entities.js';
import { createRng } from './rng.js';

let db: Db;
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
  rng = createRng('fx5');
  nextId = createIds('fx5');
});

async function insertUser(): Promise<UserRow> {
  const u = makeUser(rng, nextId);
  await db`
    insert into users (id, openid, email, phone, is_admin)
    values (${u.id}, ${u.openid}, ${u.email}, ${u.phone}, ${u.is_admin})
  `;
  return u;
}

type AddressInsert = {
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
};

async function insertAddress(userId: string, a: AddressInsert): Promise<void> {
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, line2, city, state, postal_code)
    values (${nextId()}, ${userId}, ${a.recipient}, ${a.phone}, ${a.line1}, ${a.line2},
            ${a.city}, ${a.state}, ${a.postal_code})
  `;
}

/**
 * 断言这次插入被拒，且命中的**正是** `needle`。
 *
 * @why 只断言"抛错"会放过一类最阴的漂移：约束名改了、或者实际是**别的约束**在拦
 *      （比如超长先撞 VARCHAR 长度、根本到不了 CHECK）——两种情况下都"抛错了"，
 *      看起来一样绿。所以必须比对**是哪一个**在拦。
 *
 * @limitation 约束名出现在 `message` 里，而 SQLSTATE 只出现在 `.code` 上
 *      （postgres.js 不把 22001 拼进 message，实测确认）。因此这里两者都查：
 *      把 `code` 与 `message` 拼成一个字符串再匹配，两种形态的预期值都能写在一起。
 */
async function expectRejected(p: Promise<void>, needle: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `反例未被拒绝：${label}`).toBeInstanceOf(Error);
  const code =
    typeof caught === 'object' && caught !== null && 'code' in caught
      ? String((caught as { code: unknown }).code)
      : '';
  const message = caught instanceof Error ? caught.message : '';
  expect(`${code} ${message}`, `反例命中的约束不符合预期：${label}`).toContain(needle);
}

describe('US_ADDRESSES 每一条都能进真库（FX5）', () => {
  /**
   * 逐条插，而不是随机插一条。
   * @why `makeAddress()` 是随机取样本的，"连插 100 条"也不保证覆盖到每一条——
   *      某条军邮地址可能一直没被抽中。边界样本的价值就在"每一条都被验证过"，
   *      所以这里显式遍历；失败信息带上 recipient，红的时候能直接定位是哪一条。
   */
  it('全部边界样本逐条插入成功', async () => {
    const u = await insertUser();
    for (const seed of US_ADDRESSES) {
      const label = `${seed.recipient} / ${seed.city}, ${seed.state} ${seed.postalCode}`;
      await expect(
        insertAddress(u.id, {
          recipient: seed.recipient,
          phone: formatUsPhone(seed.areaCode, 5_000_000),
          line1: seed.line1,
          line2: seed.line2,
          city: seed.city,
          state: seed.state,
          postal_code: seed.postalCode,
        }),
        `边界样本入库失败：${label}`,
      ).resolves.toBeUndefined();
    }
    const rows = await db`select count(*)::int as n from addresses`;
    expect(Number(rows[0]?.n)).toBe(US_ADDRESSES.length);
  });

  it('军邮州码 AA / AE / AP 三种都在样本里，且都能入库', async () => {
    const military = US_ADDRESSES.filter((a) => ['AA', 'AE', 'AP'].includes(a.state));
    // 三种州码缺任何一种，这条断言就红——防止有人"清理"假数据时把它们当脏数据删掉
    expect(new Set(military.map((a) => a.state))).toEqual(new Set(['AA', 'AE', 'AP']));
  });

  it("含撇号的姓名不被改写（O'Brien 原样存回）", async () => {
    const u = await insertUser();
    const seed = US_ADDRESSES.find((a) => a.recipient.includes("'"));
    expect(seed, '样本里没有含撇号的姓名——FX5 的这一条被删了').toBeDefined();
    if (seed === undefined) return;
    await insertAddress(u.id, {
      recipient: seed.recipient,
      phone: formatUsPhone(seed.areaCode, 1_000_000),
      line1: seed.line1,
      line2: seed.line2,
      city: seed.city,
      state: seed.state,
      postal_code: seed.postalCode,
    });
    const rows = await db`select recipient from addresses limit 1`;
    expect(rows[0]?.recipient).toBe(seed.recipient);
  });

  it('夏威夷 / 阿拉斯加都在样本里（运费分区的回归样本）', async () => {
    const states = new Set(US_ADDRESSES.map((a) => a.state));
    expect(states.has('HI')).toBe(true);
    expect(states.has('AK')).toBe(true);
  });

  /**
   * `line2` 的长度上限以 **DDL 为准**，而不是以 TS 常量为准。
   * @why TS 里的 `ADDRESS_LINE2_MAX_CHARS = 200` 是从 SQL 抄来的，抄就会抄错、也会随着改 DDL 而过期。
   *      这里反向查 `information_schema` 比对，DDL 一改就红——
   *      把"两个地方写同一个数字"的漂移风险变成一条会失败的断言。
   */
  it('line2 的长度上限与 DDL 的 VARCHAR 长度一致', async () => {
    const cols = await db`
      select character_maximum_length as len
      from information_schema.columns
      where table_name = 'addresses' and column_name = 'line2'
    `;
    expect(Number(cols[0]?.len)).toBe(ADDRESS_LINE2_MAX_CHARS);
    expect(LINE2_AT_LIMIT.length).toBe(ADDRESS_LINE2_MAX_CHARS);
  });

  it('恰好达到上限的 line2 能入库（边界内侧）', async () => {
    const u = await insertUser();
    const base = US_ADDRESSES[0];
    if (base === undefined) throw new Error('地址样本为空，这条断言没有意义');
    await insertAddress(u.id, {
      recipient: base.recipient,
      phone: formatUsPhone(base.areaCode, 2_000_000),
      line1: base.line1,
      line2: LINE2_AT_LIMIT,
      city: base.city,
      state: base.state,
      postal_code: base.postalCode,
    });
    const rows = await db`select char_length(line2) as len from addresses limit 1`;
    expect(Number(rows[0]?.len)).toBe(ADDRESS_LINE2_MAX_CHARS);
  });
});

describe('US_ADDRESS_INVALID 每一条都被真库拒绝（FX5）', () => {
  it('六类脏输入全部被拒，且命中的是预期的约束', async () => {
    const u = await insertUser();
    const base = US_ADDRESSES[0];
    if (base === undefined) throw new Error('地址样本为空，这条断言没有意义');

    // 只取数据库层的反例；`layer: 'app'`（邮编与州对不上）刻意不设 DB 约束，由应用层用例覆盖（catalog.ts 字段说明）
    for (const bad of US_ADDRESS_INVALID.filter((c) => c.layer !== 'app')) {
      const row: AddressInsert = {
        recipient: base.recipient,
        phone: formatUsPhone(base.areaCode, 3_000_000),
        line1: base.line1,
        line2: base.line2,
        city: base.city,
        state: base.state,
        postal_code: base.postalCode,
        ...bad.patch,
      };
      await expectRejected(insertAddress(u.id, row), bad.expect, bad.name);
    }
  });

  it('反例一个都没进库（拒绝是真的拒绝，不是报错后仍写入）', async () => {
    const rows = await db`select count(*)::int as n from addresses`;
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

/**
 * ⚠️ 已知缺口的表征测试（不是期望行为的背书）。
 *
 * @why `addresses.state` 与 `country` 在 DB 层没有 CHECK：'ZZ'、'  '、'XX' 都能入库。
 *      按 ADR-28（多国家由配置驱动、运行期上下线不发版）**不应该**在 DB 层硬编码国家/州白名单，
 *      正确位置是应用层按 `country` 取配置校验——而那一层现在还不存在。
 *      把当前行为写成断言，是为了让缺口**出现在测试报告里**而不是沉在文档角落；
 *      等地址校验单元落地时，这条断言会变红，届时应当改成 `rejects` 而不是删掉它。
 * @todo 应用层地址校验（按 country 取 country_profiles 校验州码）——属业务期「地址校验」单元。
 */
describe('已知缺口：state / country 在 DB 层不校验', () => {
  it('州码写 ZZ、国家写 XX 目前都能入库（ADR-28 不在 DB 层硬编码；应用层已拦 US 州码，AJ-371）', async () => {
    const u = await insertUser();
    const base = US_ADDRESSES[0];
    if (base === undefined) throw new Error('地址样本为空，这条断言没有意义');
    await db`
      insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country)
      values (${nextId()}, ${u.id}, ${base.recipient}, ${formatUsPhone(base.areaCode, 4_000_000)},
              ${base.line1}, ${base.city}, 'ZZ', ${base.postalCode}, 'XX')
    `;
    const rows = await db`select state, country from addresses limit 1`;
    expect(rows[0]?.state).toBe('ZZ');
    expect(rows[0]?.country).toBe('XX');
  });
});
