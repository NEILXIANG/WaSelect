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
