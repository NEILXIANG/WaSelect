/**
 * 职责：`country_profiles` 的真库用例（F11 单元④，L1 层）。
 *
 * @why 这一层的重点不是"SQL 写得对不对"，而是**表里的数据与 `addresses` 表的现行约束同不同源**。
 *      国家档案的全部价值建立在"它描述的就是数据库实际执行的规则"上：一旦两边漂移，
 *      前端按档案放行、后端被 CHECK 拒绝，用户看到的是"提交失败"而日志里是"地址格式错误"——
 *      没人会想到去比对两张表。所以这里做**字段级同源比对**（第 4 组用例）。
 *
 * @why 用 `createCountryProfileRepo(db)` 而不是直接查库：测试必须走今后业务侧真正会走的那条路。
 *      若哪天有人绕过仓储直接写 SQL，这里不会红——但那时"唯一读取口"这件事已经没了，
 *      这条限制由分层 lint 从另一侧兜住（F10）。
 *
 * @limitation `country_profiles` 被 `resetTestDb()` **排除在清空名单之外**（它是配置表，见 test-db.ts），
 *              所以用例之间它的数据会残留。本文件的对策：`beforeEach` 删掉用例自己造的国家，
 *              改坏 seed 的那条用例用 try/finally 还原。这是"配置表不清空"的代价，
 *              换来的是测试环境与生产同构（生产上这张表永远有 US 那条）。
 *
 * @see server/src/adapters/country-profiles.ts（被测）；migrations/007_country_profiles.sql（表与 seed）；
 *      test/db/test-db.ts（truncate 排除名单）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createCountryProfileRepo, type CountryProfileRepo } from './country-profiles.js';

let db: Db;
let repo: CountryProfileRepo;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
  repo = createCountryProfileRepo(db);
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  // 清掉上一条用例造的国家（seed 的 US 保留）
  await db`delete from country_profiles where code <> 'US'`;
});

/** 插一条测试用的国家档案。未列出的列走表默认值。 */
async function insertCountry(code: string, active: boolean): Promise<void> {
  await db`
    insert into country_profiles (code, active, display_currencies, address_template, phone_pattern, postal_pattern)
    values (
      ${code}, ${active}, '["JPY"]'::jsonb,
      '{"fields":[{"key":"city","label":"城市","required":true,"maxLength":100}]}'::jsonb,
      '^[ -~]+$', '^[0-9]{5}$'
    )`;
}

describe('种子与基本读取', () => {
  it('迁移 seed 的 US 一条可读，且是 active', async () => {
    const us = await repo.get('US');
    expect(us).not.toBeNull();
    expect(us?.code).toBe('US');
    expect(us?.active).toBe(true);
    expect(us?.displayCurrencies).toEqual(['CNY', 'USD']);
    expect(us?.dutyNote).toContain('DDP');
  });

  /**
   * 三审业务一致性 A2：seed 文案曾写"价格已含关税**与运费**"，与 D-32（商品价含关税、
   * **运费按重量分档单列**）直接相反——这段是"前端展示的关税口径文案"，接入详情页后就是
   * 向用户承诺含运费、结算页再收运费的投诉 / 拒付证据。文案必须明确"运费单列"。
   */
  it('US 的 duty_note 与 D-32 一致：含关税、运费单列（不得承诺"含运费"）', async () => {
    const us = await repo.get('US');
    expect(us?.dutyNote).toContain('关税');
    expect(us?.dutyNote).toContain('运费');
    expect(us?.dutyNote).not.toMatch(/含关税与运费|含运费/);
    expect(us?.dutyNote).toMatch(/运费.*单列|单列.*运费/);
  });

  it('resetTestDb 之后种子仍在：配置表不参与清空（否则测试环境与生产不同构）', async () => {
    // @why 这条守的是 test-db.ts 的 truncate 排除名单。哪天有人把 country_profiles 加回名单，
    //      本文件里每一条"读 US"的断言都会红——但那时归因会指向"seed 没建"，
    //      而真正的改动在一个八竿子打不着的文件里。显式钉住它，归因就是准的。
    await resetTestDb(db);
    expect(await repo.get('US')).not.toBeNull();
  });

  it('不存在的国家返回 null，不抛错', async () => {
    // @why "没有这个国家"是**正常查询结果**不是错误：它对应"用户选了一个我们还没开通的国家"。
    //      抛错会让"不支持"与"系统故障"在调用方眼里长得一样。
    expect(await repo.get('CA')).toBeNull();
  });

  it('listActive 只返回 active 的国家', async () => {
    await insertCountry('CA', true);
    await insertCountry('MX', false);
    const codes = (await repo.listActive()).map((p) => p.code);
    expect(codes).toContain('US');
    expect(codes).toContain('CA');
    expect(codes).not.toContain('MX');
  });
});

describe('get 与 listActive 的语义差异', () => {
  it('已下线的国家：listActive 里没有，但 get 仍然拿得到', async () => {
    // @why 这是本单元最容易被抹平的一条语义。若 get 也只返回 active，
    //      "国家被下线"与"国家不存在"在调用方眼里都是 null，运营问"为什么美国不能下单了"
    //      时日志里只剩一个 null，无法区分"我们关掉了它"和"数据没了"。
    await insertCountry('MX', false);
    const inactive = await repo.get('MX');
    expect(inactive).not.toBeNull();
    expect(inactive?.active).toBe(false);
    expect((await repo.listActive()).map((p) => p.code)).not.toContain('MX');
  });
});

describe('数据库层约束（应用层校验之外的第二道）', () => {
  it('code 非两位大写 → 库直接拒绝', async () => {
    // @why 应用层 zod 也查这个，但那只在**读**的时候查；这里是防止有人写坏数据进去。
    //      两道都要有：只读校验拦不住"先写坏再读"，只写校验拦不住存量脏数据。
    await expect(insertCountry('us', true)).rejects.toThrow();
    await expect(insertCountry('USA', true)).rejects.toThrow();
  });

  it('display_currencies 不是数组 → 库拒绝', async () => {
    await expect(
      db`
        insert into country_profiles (code, display_currencies, address_template, phone_pattern, postal_pattern)
        values ('CA', '{"not":"an array"}'::jsonb,
                '{"fields":[{"key":"city","label":"城市","required":true}]}'::jsonb,
                '^[ -~]+$', '^[0-9]{5}$')`,
    ).rejects.toThrow();
  });

  it('地址模板 fields 为空数组 → 库拒绝', async () => {
    await expect(
      db`
        insert into country_profiles (code, address_template, phone_pattern, postal_pattern)
        values ('CA', '{"fields":[]}'::jsonb, '^[ -~]+$', '^[0-9]{5}$')`,
    ).rejects.toThrow();
  });

  it('读到一个被手工改坏的国家 → 响亮抛错，不静默降级', async () => {
    const original = (await db`select phone_pattern from country_profiles where code = 'US'`)[0]
      ?.phone_pattern as string;
    try {
      await db`update country_profiles set phone_pattern = '(' where code = 'US'`;
      await expect(repo.get('US')).rejects.toThrow(/phone_pattern/);
      // 一条坏数据让整个列表失败是**刻意**的取舍（见 country-profiles.ts @tradeoff）：
      // 静默跳过会变成"下单页少一个国家且没人知道"
      await expect(repo.listActive()).rejects.toThrow(/country_profiles\[US\]/);
    } finally {
      await db`update country_profiles set phone_pattern = ${original} where code = 'US'`;
    }
  });
});

describe('与 addresses 表现行约束的同源比对', () => {
  /**
   * 取出 addresses 表每个列的 CHECK 正则。
   * @returns 列名 → 正则。没有正则约束的列（如 state）不在 map 里。
   * @why 从**库里实际的约束**取，而不是从迁移文件文本里正则提取：
   *      迁移文件里的写法会被后续迁移 ALTER 覆盖，读文件等于读一份可能过期的副本。
   */
  async function checkPatterns(): Promise<Map<string, string>> {
    const rows = await db`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'addresses'::regclass and contype = 'c'`;
    const out = new Map<string, string>();
    for (const r of rows) {
      // ⚠️ PG 实际输出是 `CHECK (((phone)::text ~ '^\+1[0-9]{10}$'::text))`——
      //    列名被**括号包住**且带 `::text` 显式转换，不是迁移文件里写的 `phone ~ '...'`。
      //    第一版正则漏了这两层，于是 `::text` 里的 `text` 被当成列名抓走：
      //    六条约束全部落到同一个 key，Map 只剩 1 条，而所有业务断言照样绿
      //    （因为 `checks.get('phone')` 返回 undefined，`toBe(undefined)` …… 见自检）。
      //    括号与 cast 都写成可选，两种形态都能抓。
      // line2 那条是 `CHECK (((line2 IS NULL) OR ((line2)::text ~ '...'::text)))`：
      //    前半段 `(line2 IS NULL)` 后面接的不是 `~`，会匹配失败并由引擎前进到后半段命中。
      const m = /\(?([a-z_][a-z0-9_]*)\)?(?:::\w+)?\s*~\s*'([^']*)'/.exec(String(r.def));
      if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
    }
    return out;
  }

  /** 取出 addresses 表的列宽（字符类型）。TEXT 列无上限 → 存 null。 */
  async function columnWidths(): Promise<Map<string, number | null>> {
    const rows = await db`
      select column_name, character_maximum_length
      from information_schema.columns
      where table_schema = 'public' and table_name = 'addresses'`;
    return new Map(
      rows.map((r) => [String(r.column_name), r.character_maximum_length as number | null]),
    );
  }

  // ⚠️ 自检放最前面（§2 第 34 条）：上面两个扫描器写坏时，下面所有业务断言**照样全绿**
  // （扫不到东西 → 比对循环一次都不进 → 一条断言都没跑）。这是本项目第四次同形态的坑。
  it('自检：约束扫描器真的抓到了 addresses 的 CHECK 正则', async () => {
    const checks = await checkPatterns();
    // 钉住**完整的列名集合**而不是只钉 size：加/删一条地址约束都要让这里红一次，
    // 因为国家档案必须跟着改——这正是 ADR-28 §3.2「不允许只改约束不改档案」的另一半。
    expect([...checks.keys()].sort()).toEqual([
      'city',
      'line1',
      'line2',
      'phone',
      'postal_code',
      'recipient',
    ]);
    expect(checks.get('phone')).toBe('^\\+1[0-9]{10}$');
    expect(checks.get('postal_code')).toBe('^[0-9]{5}(-[0-9]{4})?$');
  });

  it('自检：列宽扫描器抓到了 addresses 的列（state 必须是 2）', async () => {
    const widths = await columnWidths();
    expect(widths.size).toBeGreaterThan(5);
    expect(widths.get('state')).toBe(2);
    expect(widths.get('phone')).toBe(20);
  });

  it('顶层的 phone / postal pattern 与 addresses 的 CHECK 逐字一致', async () => {
    const us = await repo.get('US');
    const checks = await checkPatterns();
    expect(us?.phonePattern).toBe(checks.get('phone'));
    expect(us?.postalPattern).toBe(checks.get('postal_code'));
  });

  it('模板里每个字段的 key 都是 addresses 的真实列名（否则"模板 → 落库"映射断裂）', async () => {
    const us = await repo.get('US');
    const widths = await columnWidths();
    for (const f of us?.addressTemplate.fields ?? []) {
      expect(widths.has(f.key), `字段 key "${f.key}" 不是 addresses 的列`).toBe(true);
    }
  });

  it('模板里每个字段的 pattern 与该列的 CHECK 逐字一致（有 CHECK 的列）', async () => {
    const us = await repo.get('US');
    const checks = await checkPatterns();
    let compared = 0;
    for (const f of us?.addressTemplate.fields ?? []) {
      const expected = checks.get(f.key);
      if (expected === undefined) continue; // 该列没有正则约束（当前只有 state）
      expect(f.pattern, `字段 ${f.key} 的 pattern 必须与 addresses 的 CHECK 一致`).toBe(expected);
      compared += 1;
    }
    // 防止 `continue` 吞掉全部比对（扫不到东西时 compared 会是 0，而上面没有一条断言跑过）
    expect(compared).toBeGreaterThanOrEqual(5);
  });

  it('模板里每个字段的 maxLength 不超过该列的列宽（否则前端让填、后端落库被拒）', async () => {
    const us = await repo.get('US');
    const widths = await columnWidths();
    let compared = 0;
    for (const f of us?.addressTemplate.fields ?? []) {
      if (f.maxLength === undefined) continue;
      const width = widths.get(f.key);
      if (width === null || width === undefined) continue; // TEXT 列无上限
      expect(f.maxLength, `字段 ${f.key} 的 maxLength 超过列宽 ${width}`).toBeLessThanOrEqual(
        width,
      );
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(6);
  });
});
