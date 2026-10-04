/**
 * 职责：`adapters/ops-config.ts` 的真库用例（I2 U-C2）——汇率写入与运费**整表替换**。
 *
 * @why 整表替换必须**真库**测且必须验**事务回滚**：`delete` + 批量 `insert` 里途中有一步失败，
 *      留下的不是"没保存"，而是**半张表甚至空表**——空表的后果是**全站无法报价**（50004）。
 *      这是本文件唯一一条"失败路径"用例，也是最有价值的一条。
 *
 * @why 替换后要用 `catalog.findShippingPriceJpy`（D-46 唯一取档实现）**交叉验证**：
 *      本仓储写进表的数据最终只被那一处消费。自己写一条 SQL 去数行数，
 *      是"自己造数据自己断言"（§2 第 21 条）——验证不了"取档方向还正确吗"。
 *
 * @limitation 汇率插入的**唯一约束**（UNIQUE(quote, effective_from)）只测"能插"，
 *              冲突路径由路由层转错误码，在那边验。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, resetTestDb, testDb } from '../../../test/db/test-db.js';
import { createOpsConfigRepo } from './ops-config.js';
import { createCatalogRepo } from './catalog.js';

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

const T0 = Date.parse('2026-09-27T00:00:00Z');

describe('listFxRates / insertFxRate', () => {
  it('空表 → []（不报错，前端按"今天没配汇率"展示）', async () => {
    expect(await createOpsConfigRepo(db).listFxRates()).toEqual([]);
  });

  it('插入后可读回，rate / raw_rate / buffer 与写入值一致', async () => {
    const repo = createOpsConfigRepo(db);
    const row = await repo.insertFxRate({
      quote: 'USD',
      rate: 0.006695,
      rawRate: 0.0065,
      buffer: 0.03,
      effectiveFromMs: T0,
      createdBy: 'admin:u-1',
    });
    expect(row.quote).toBe('USD');
    expect(row.rate).toBe(0.006695);
    expect(row.raw_rate).toBe(0.0065);
    expect(row.buffer).toBe(0.03);
    expect(row.effective_from.getTime()).toBe(T0);

    const all = await repo.listFxRates();
    expect(all).toHaveLength(1);
    expect(all[0]?.rate).toBe(0.006695);
  });

  it('排序：quote 升序，同币种内 effective_from **降序**（最新一行在最上面）', async () => {
    const repo = createOpsConfigRepo(db);
    for (const [quote, ms] of [
      ['USD', T0],
      ['CNY', T0],
      ['USD', T0 + 86_400_000],
    ] as const) {
      await repo.insertFxRate({
        quote,
        rate: 0.01,
        rawRate: 0.01,
        buffer: 0,
        effectiveFromMs: ms,
        createdBy: 'admin:u-1',
      });
    }
    const all = await repo.listFxRates();
    expect(all.map((r) => r.quote)).toEqual(['CNY', 'USD', 'USD']);
    expect(all[1]?.effective_from.getTime()).toBe(T0 + 86_400_000);
    expect(all[2]?.effective_from.getTime()).toBe(T0);
  });
});

describe('findLatestFxRate', () => {
  it('取该币种**已生效**的最新一行；未来行不算', async () => {
    const repo = createOpsConfigRepo(db);
    for (const ms of [T0 - 86_400_000, T0, T0 + 86_400_000]) {
      await repo.insertFxRate({
        quote: 'USD',
        rate: 0.01,
        rawRate: 0.01,
        buffer: 0,
        effectiveFromMs: ms,
        createdBy: 'admin:u-1',
      });
    }
    const now = new Date(T0 + 1000);
    expect((await repo.findLatestFxRate('USD', now))?.effective_from.getTime()).toBe(T0);
    // 未来行在生效那一刻之前不该被选中（否则"提前录入明日汇率"会立刻改写今天的展示价）
    expect(
      (await repo.findLatestFxRate('USD', new Date(T0 - 86_400_000)))?.effective_from.getTime(),
    ).toBe(T0 - 86_400_000);
  });

  it('没有该币种 → null（不抛，路由层据此判断"首次维护"）', async () => {
    expect(await createOpsConfigRepo(db).findLatestFxRate('CNY', new Date(T0))).toBeNull();
  });
});

describe('listShippingRates', () => {
  it('按 carrier 升序、同承运商内 max_weight_g 升序（分档表语义就是"从轻到重"）', async () => {
    const repo = createOpsConfigRepo(db);
    await repo.replaceShippingRates([
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: true },
      { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
    ]);
    const rows = await repo.listShippingRates();
    expect(rows.map((r) => r.max_weight_g)).toEqual([500, 2000]);
    expect(rows[0]?.price_jpy).toBe(2100);
  });
});

describe('replaceShippingRates', () => {
  it('整表替换：旧档全没、新档全在，active 原样落库', async () => {
    const repo = createOpsConfigRepo(db);
    await repo.replaceShippingRates([
      { carrier: 'old', maxWeightG: 1000, priceJpy: 3000, active: true },
    ]);
    await repo.replaceShippingRates([
      { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: false },
    ]);
    const rows = await repo.listShippingRates();
    expect(rows).toEqual([
      { carrier: 'placeholder', max_weight_g: 500, price_jpy: 2100, active: true },
      { carrier: 'placeholder', max_weight_g: 2000, price_jpy: 4950, active: false },
    ]);
  });

  it('🔴 中途失败必须回滚：旧表一张不少（否则留下空表 = 全站无法报价）', async () => {
    const repo = createOpsConfigRepo(db);
    const before = [
      { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: true },
    ];
    await repo.replaceShippingRates(before);

    // 构造一条能骗过 domain 校验、但会被 DB 拒的输入：max_weight_g 溢出 INT4
    await expect(
      repo.replaceShippingRates([
        { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
        { carrier: 'placeholder', maxWeightG: 3_000_000_000, priceJpy: 4950, active: true },
      ]),
    ).rejects.toThrow();

    const after = await repo.listShippingRates();
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.max_weight_g)).toEqual([500, 2000]);
  });

  it('替换后 D-46 取档仍然正确（交叉验证，不自己写第二份取档 SQL）', async () => {
    const repo = createOpsConfigRepo(db);
    await repo.replaceShippingRates([
      { carrier: 'placeholder', maxWeightG: 1000, priceJpy: 4050, active: true },
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: true },
    ]);
    const catalog = createCatalogRepo(db);
    expect(await catalog.resolveSingleActiveCarrier()).toBe('placeholder');
    // 红线向量：1850g 必须取 2000 档（4950）。返回 4050 = 向下取档 = D-46 事故
    expect(await catalog.findShippingPriceJpy('placeholder', 1850)).toBe(4950);
    expect(await catalog.findShippingPriceJpy('placeholder', 1000)).toBe(4050);
    expect(await catalog.findShippingPriceJpy('placeholder', 2500)).toBeNull();
  });

  /**
   * B22 / AJ-204：两次并发整表替换，库里必须**恰好等于后到那次的输入**，不能是并集。
   *
   * @why 旧实现（没有表级锁）在 READ COMMITTED 下会得到并集：
   *      B 的 `delete` 看不见 A 未提交的新行（空表起步时连"可锁的行"都没有），
   *      于是 B 删了个空、插入自己的档，A 提交后库里就是 A ∪ B。
   *      后果最重的两种：① 两个承运商的档混在一起 ⇒ `resolveSingleActiveCarrier()` 返回 null
   *      ⇒ **全站 50004 无法报价**；② 同一承运商的新旧档混在一起 ⇒ **静默算错运费**。
   * @how **不用 sleep 抢时序**：模拟"先到者 A 还没提交"这一确定状态——
   *      A 的事务手动 `begin` 并持住（删 + 插完就等一个信号），此时 B 才进来。
   *      这样"并集"是**必然**结果而不是概率结果（探针 5/5 是运气，用例不能靠运气）。
   *      ⚠️ 修正（同一条用例的第一版）：光靠"并发发起"不够——实测 B 常常在 A 提交之后
   *      才开始，于是顺序化、用例假绿。所以判据不是"多快"，而是**给足 500ms 看 B 能不能
   *      自己跑完**：有锁 ⇒ 它必然跑不完（堵在表锁上）；无锁 ⇒ 几十毫秒就跑完 ⇒ 立刻红。
   * @why 断言**库里的内容**而不只是返回值：B 的返回值来自它自己事务内的读，
   *      即便没有锁也是"B 的行"（看不到 A）——只断言返回值会假绿。
   *      **第二现场**（提交后再读一遍）才是这个缺陷真正的显影处（同 B23 的教训）。
   */
  it('并发整表替换：后到者整表覆盖，库里恰好等于后到那次（B22 / AJ-204）', async () => {
    const repo = createOpsConfigRepo(db);
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let opened: () => void = () => {};
    const openedP = new Promise<void>((r) => {
      opened = r;
    });

    // 先到者 A：删空 + 插自己的档，然后**持住不提交**
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const holdA = db.begin(async (tx) => {
      await tx`delete from shipping_rates`;
      await tx`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('A', 500, 1000, true), ('A', 2000, 4000, true)
      `;
      opened();
      await released;
    });
    await openedP;

    const B_ROWS = [{ carrier: 'B', maxWeightG: 700, priceJpy: 2000, active: true }];
    let bSettled = false;
    const bDone = repo.replaceShippingRates(B_ROWS).then(
      (r) => {
        bSettled = true;
        return r;
      },
      (e: unknown) => {
        bSettled = true;
        throw e;
      },
    );
    // 给 B 最多 500ms 让它"自己跑完"：无锁时它一次 delete + 一条 insert，几十毫秒必然完成；
    // 有锁时它堵在表锁上，永远等不到——这正是本用例要钉的区别（判据不是快慢，是能不能）。
    for (let i = 0; i < 50 && !bSettled; i += 1) await sleep(10);
    expect(bSettled).toBe(false); // 🔴 无锁时这里是 true（B 抢在 A 提交之前跑完了）

    release();
    await holdA;
    const out = await bDone;

    // ① 返回值（B 自己看到的）
    expect(out.after).toEqual([{ carrier: 'B', max_weight_g: 700, price_jpy: 2000, active: true }]);
    // ② 库里：**两次都提交之后**再读一遍——无锁时这里是 A ∪ B（3 行）
    expect(await repo.listShippingRates()).toEqual(out.after);
  });

  /**
   * 🔴 AJ-354：并发替换时，后到者的 `before` 必须是**先到者刚提交的那张表**。
   *
   * @why 审计流 B 存在的唯一理由是"整表替换不可逆，一定要答得上之前是多少"
   *      （`admin-ops-routes.ts` 文件头）。改前值若在**锁外**读（旧实现：路由先
   *      `listShippingRates()` 再调替换），两次并发保存时两个请求读到的都是
   *      **最初**那张表 ⇒ 后到者的审计 before 指向一张早已被覆盖的表，
   *      而"先到者写进去的是什么"只能从它自己的 after 里反推——
   *      审计还能拼出事实，但**日志里那条 before 是错的**，且没有任何症状。
   * @how 复用 B22 的"A 持住不提交"骨架：**先到者 A 的输入**是确定已知的，
   *      所以断言可以写成"before 恰好等于 A 的输入"，而不是"before 不是最初那张表"
   *      ——后者在 B 恰好也读到旧表时也可能成立，判据不够特异。
   */
  it('🔴 并发整表替换：后到者的 before = 先到者刚提交的表，不是最初那张（AJ-354）', async () => {
    const repo = createOpsConfigRepo(db);
    const INITIAL = [{ carrier: 'initial', maxWeightG: 300, priceJpy: 900, active: true }];
    await repo.replaceShippingRates(INITIAL);

    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let opened: () => void = () => {};
    const openedP = new Promise<void>((r) => {
      opened = r;
    });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    // 先到者 A：手写 SQL 复刻 replaceShippingRates 的前三步（锁 → 删 → 插），**持住不提交**。
    // @why 不能直接用 `repo.replaceShippingRates(A_ROWS)`：它自己会提交，那就造不出
    //      "A 已写入但未提交"这个确定状态（B22 那条用例同因）。
    const holdA = db.begin(async (tx) => {
      await tx`lock table shipping_rates in exclusive mode`;
      await tx`delete from shipping_rates`;
      await tx`
        insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
        values ('A', 500, 1000, true)
      `;
      opened();
      await released;
    });
    await openedP;

    const B_ROWS = [{ carrier: 'B', maxWeightG: 700, priceJpy: 2000, active: true }];
    let bSettled = false;
    const bDone = repo.replaceShippingRates(B_ROWS).then(
      (r) => {
        bSettled = true;
        return r;
      },
      (e: unknown) => {
        bSettled = true;
        throw e;
      },
    );
    for (let i = 0; i < 50 && !bSettled; i += 1) await sleep(10);
    expect(bSettled).toBe(false); // B 必然堵在表锁上（否则下面两条断言没有意义）

    release();
    await holdA;
    const out = await bDone;

    // ① before = A 刚提交的那张表（不是 initial）
    expect(out.before).toEqual([
      { carrier: 'A', max_weight_g: 500, price_jpy: 1000, active: true },
    ]);
    expect(out.before.map((r) => r.carrier)).not.toContain('initial');
    // ② after = B 自己那张
    expect(out.after).toEqual([{ carrier: 'B', max_weight_g: 700, price_jpy: 2000, active: true }]);
    // ③ 单次（无并发）替换时 before 就是调用前那张表——语义不能被这次改动带偏
    const solo = await repo.replaceShippingRates([
      { carrier: 'C', maxWeightG: 900, priceJpy: 3000, active: true },
    ]);
    expect(solo.before).toEqual(out.after);
  });

  it('请求体相同的两次并发替换：都成功，不撞 23505（B22 的第三种表现）', async () => {
    const repo = createOpsConfigRepo(db);
    const same = [
      { carrier: 'placeholder', maxWeightG: 500, priceJpy: 2100, active: true },
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: true },
    ];
    const [r1, r2] = await Promise.all([
      repo.replaceShippingRates(same),
      repo.replaceShippingRates(same),
    ]);
    expect(r1.after).toEqual(r2.after);
    expect(await repo.listShippingRates()).toHaveLength(2);
  });

  it('停用全部档位后取档为 null（前端已挡，这里确认语义如此）', async () => {
    const repo = createOpsConfigRepo(db);
    await repo.replaceShippingRates([
      { carrier: 'placeholder', maxWeightG: 2000, priceJpy: 4950, active: false },
    ]);
    expect(await createCatalogRepo(db).findShippingPriceJpy('placeholder', 100)).toBeNull();
  });
});
