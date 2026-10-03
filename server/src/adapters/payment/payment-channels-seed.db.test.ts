/**
 * 职责：010 迁移三张配置表的**种子同源比对**（I1-U7a，L1 层）。
 *
 * @why `payment_channels` 的种子值必须**逐字等于** `CHANNEL_DEFAULTS`：表（010）与常量（channels.ts）
 *      是两份描述同一件事的数据，一旦漂移，将来"消费方从 env 切到读表"那天行为就会静默改变——
 *      而那天恰恰是最不想出意外的一天。所以切换之前就用字段级比对把两份钉在一起
 *      （与 007 country_profiles ↔ addresses CHECK 的同源比对同一手法）。
 *
 * @why `duty_rates` 只断言 ('JP','US',0.15) 这一条种子在：它是 I1 报价域（U4）的输入，
 *      且 13b 未定——note 里必须带着"未定"字样，防止有人把占位当结论（010 迁移注释 @limitation 一）。
 *
 * @why `app_config` 断言**零行**：010 刻意不落 seed（没有消费方的 key 是死数据），
 *      谁往里塞了东西，谁就必须在同一次提交里带来消费方——这条用例就是那句话的执行者。
 *
 * @limitation 三张表都被 resetTestDb 排除（配置表），用例之间数据残留——
 *              本文件只做**只读断言**，不写任何一行（写会污染其它文件的用例）。
 *
 * @see migrations/010_config_tables.sql；adapters/payment/channels.ts（CHANNEL_DEFAULTS）；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §3（ADR-28）
 */
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../db.js';
import { ensureTestDb, testDb } from '../../../../test/db/test-db.js';
import { CHANNEL_DEFAULTS } from './channels.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

describe('payment_channels 种子 ↔ CHANNEL_DEFAULTS 同源', () => {
  it('通道集合一致（表里的 key 不多不少就是默认表那些）', async () => {
    const rows = await db`select channel from payment_channels order by channel`;
    expect(rows.map((r) => String(r.channel)).sort()).toEqual(Object.keys(CHANNEL_DEFAULTS).sort());
  });

  it('每个通道的 priority/countries/currencies/label/icon 逐字段相等', async () => {
    const rows = await db`
      select channel, priority, countries, currencies, label, icon from payment_channels
    `;
    for (const row of rows) {
      const channel = String(row.channel);
      const defaults = CHANNEL_DEFAULTS[channel];
      expect(defaults, `payment_channels 有 CHANNEL_DEFAULTS 没有的通道：${channel}`).toBeDefined();
      expect({
        priority: Number(row.priority),
        countries: row.countries,
        currencies: row.currencies,
        label: String(row.label),
        icon: row.icon === null ? undefined : String(row.icon),
      }).toEqual({
        priority: defaults?.priority,
        countries: defaults?.countries,
        currencies: defaults?.currencies,
        label: defaults?.label,
        icon: defaults?.icon,
      });
    }
  });

  it('enabled 基线：wechat 未实现不开放新单（R1），mock/stripe 开放', async () => {
    const rows = await db`select channel, enabled from payment_channels`;
    const enabled = Object.fromEntries(rows.map((r) => [String(r.channel), Boolean(r.enabled)]));
    expect(enabled).toEqual({ wechat: false, stripe: true, mock: true });
  });

  /**
   * DB-16（CAT-15）：`payment_channels.channel` 的**可用宽度**必须等于 `payments.provider` 的列宽。
   *
   * @why 010 原本允许 32 字符，而 `payments.provider` 是 VARCHAR(16)。
   *      于是运营可以配出一个**存得进配置表、写不进 payments** 的通道名：
   *      错误要到下单那一刻才以 22001 冒出来，而配置是几周前填的——
   *      没人会把"下单报串太长"和"通道名多写了几个字符"连起来。
   * @why 期望宽度**从 `payments.provider` 实读**，不在用例里写死 16：
   *      这样它验的是"两处**一致**"这个不变式本身。将来若有人把 provider 放宽到 32，
   *      这条会红，而红的意思是"记得同时放宽 022 的 CHECK"——正是想要的那次对话。
   * @limitation ⚠️ 本文件 @limitation 写的是"只做只读断言"——这条破了例，
   *      但方式是**整段放在一个必然回滚的事务里**，`db.begin` 的回调一抛就 ROLLBACK，
   *      所以"写"只是"试一下会不会被拒"的手段，任何情况下都不留行。
   * @limitation ⚠️ **两段都必须显式抛哨兵来强制回滚**，不能指望"第二条 insert 会抛"。
   *      @why 这是本用例初版踩的坑（见 §2）：②原来的写法是
   *      `insert(16) → insert(17)`，靠**第二条抛错**来触发 ROLLBACK。
   *      注入实验（把约束放宽回 32）时第二条**没抛**，事务正常 COMMIT，
   *      于是两条探针行留在了 `payment_channels` 里——而它是**配置表**，
   *      被 resetTestDb 排除、不会被清掉，污染会一直带到别的文件。
   *      更糟的是它让"注入取到红灯"这件事看起来成功了，实际留下了一个脏库。
   *      **"靠被测行为失败来顺带清理"是循环论证**：行为不失败的那天就没有清理。
   */
  it('🔴 长度等于 provider 列宽能存、多一个字符被拒（022 收紧后的形状）', async () => {
    const rows = await db`
      select character_maximum_length::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'payments' and column_name = 'provider'
    `;
    const n = Number(rows[0]?.n);
    expect(n, 'payments.provider 必须有明确的字符上限，否则本用例无从比对').toBeGreaterThan(0);

    /**
     * `db.begin` 回调拿到的是**事务对象**（`TransactionSql`），不是 `Db`
     * （tsc 会报"缺少 CLOSE / END 等属性"）。
     * ⚠️ 不能写 `Parameters<Parameters<typeof db.begin>[0]>[0]` 去推导：
     *    `begin` 有**两个重载**（`begin(cb)` 与 `begin(options, cb)`），
     *    `Parameters` 取的是**最后一个**重载 ⇒ 推出 `string`，随后一切变成 `never`。
     *    直接用 postgres.js 导出的类型，别写 `any`——本文件只有这一处真写库，
     *    正是最需要类型保护的地方。
     */
    type Tx = TransactionSql<{ int8: number }>;

    /** 只插关键列；countries/currencies 有 CHECK，给空数组即可。 */
    const insert = (tx: Tx, channel: string) => tx`
      insert into payment_channels (channel, enabled, priority, countries, currencies, label)
      values (${channel}, true, 99, '[]'::jsonb, '[]'::jsonb, 'probe')
    `;

    // 无论被拒还是成功，都靠这个哨兵把事务带进 ROLLBACK（见上一条 @limitation）
    const ROLLBACK = '__rollback__';

    // ① 恰好等于列宽：能存（若这里就抛，说明约束收得比列还紧，同样是错——只是方向相反）
    let fitErr: unknown;
    const fitOutcome = await db
      .begin(async (tx) => {
        fitErr = await insert(tx, 'a'.repeat(n)).then(
          () => undefined,
          (e: unknown) => e,
        );
        throw new Error(ROLLBACK);
      })
      .catch((e: unknown) => e);
    expect(String((fitOutcome as Error).message), '① 必须被哨兵带进回滚').toContain(ROLLBACK);
    expect(fitErr, `长度 ${n} 的通道名应能存进配置表`).toBeUndefined();

    // ② 多一个字符：必须被 CHECK 拒（23514），且报的是那一条约束
    let overErr: unknown;
    const overOutcome = await db
      .begin(async (tx) => {
        await insert(tx, 'a'.repeat(n));
        overErr = await insert(tx, 'a'.repeat(n + 1)).then(
          () => undefined,
          (e: unknown) => e,
        );
        throw new Error(ROLLBACK);
      })
      .catch((e: unknown) => e);
    expect(String((overOutcome as Error).message), '② 必须被哨兵带进回滚').toContain(ROLLBACK);
    expect(
      overErr,
      `长度 ${n + 1} 的通道名应被 CHECK 拒（它能存但写不进 payments.provider）`,
    ).toBeDefined();
    expect(String((overErr as { code?: string }).code)).toBe('23514');
    expect(String((overErr as Error).message)).toContain('payment_channels_key_shape');

    // ③ 兜底：探针行一条都不许留下（配置表不被 resetTestDb 清，残留会污染别的文件）
    const probes = await db`select channel from payment_channels where label = 'probe'`;
    expect(probes, '探针行必须全部回滚，配置表的残留会污染其它用例').toEqual([]);
  });
});

describe('duty_rates 种子', () => {
  it("('JP','US',0.15) 在，且 note 带着 13b 未定声明（防占位被当结论）", async () => {
    const rows = await db`
      select rate, note from duty_rates where origin_country = 'JP' and dest_country = 'US'
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.rate)).toBe(0.15);
    expect(String(rows[0]?.note)).toContain('13b');
    expect(String(rows[0]?.note)).toContain('未定');
  });

  it('rate 落在 [0,1)（CHECK 兜底之外，断言种子本身没写错量纲）', async () => {
    const rows = await db`select rate from duty_rates`;
    for (const r of rows) {
      const rate = Number(r.rate);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThan(1);
    }
  });
});

describe('app_config', () => {
  it('零行（010 刻意不落 seed：第一个 key 必须连同消费方一起落地）', async () => {
    const rows = await db`select count(*)::int as n from app_config`;
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
