/**
 * 职责：`payment_channels` **读取口**的 L1 用例（R2-4 接线 / AJ-379）。
 *
 * @why 读取口是"表 → 装配"之间唯一的一段代码，它错了的表现是**整条接线静默失效**：
 *      JSONB 取出来形状不对、icon 的 null 没转成 undefined、行没读全——
 *      每一种的结果都是"装配处拿到别的值"，而启动日志照样一切正常。
 *      所以这里不测 SQL 语法（那由它跑通证明），只测**取到的东西是不是表里那个东西**。
 *
 * @limitation 本文件**只读**（配置表被 `resetTestDb` 排除，写会污染别的文件）。
 *      "改数据 → 读到新值"那一段由 `app/pay-channels-config.db.test.ts` 在事务里做。
 *
 * @see migrations/010_config_tables.sql；adapters/payment/channels.ts（CHANNEL_DEFAULTS）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './db.js';
import { ensureTestDb, testDb } from '../../../test/db/test-db.js';
import { CHANNEL_DEFAULTS } from './payment/channels.js';
import { loadChannelConfigs } from './payment-channel-config.js';

let db: Db;

beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);

afterAll(async () => {
  await closeDb(db);
});

describe('loadChannelConfigs（payment_channels 读取口）', () => {
  it('读到表里全部通道，顺序稳定（按 channel 排序）', async () => {
    const rows = await loadChannelConfigs(db);
    expect(rows.length).toBeGreaterThan(0);
    const channels = rows.map((r) => r.channel);
    expect(channels).toEqual([...channels].sort());
  });

  /**
   * @why 与 seed 的那种子同源比对（payment-channels-seed.db.test.ts）**不是同一件事**：
   *      那边比的是"迁移写的种子 == 常量"，这边比的是"读取口取出来的 == 常量"。
   *      少了这一条，读取口完全可以在种子正确的情况下把值取错（类型、列名、JSONB 解析），
   *      而那边的用例依然全绿。
   */
  it.each(Object.keys(CHANNEL_DEFAULTS))(
    '%s：读取口取到的字段与 CHANNEL_DEFAULTS 逐字段相等',
    async (channel) => {
      const rows = await loadChannelConfigs(db);
      const row = rows.find((r) => r.channel === channel);
      expect(row, `表里没有 ${channel} 这一行`).toBeDefined();
      const want = CHANNEL_DEFAULTS[channel];
      expect(want, `CHANNEL_DEFAULTS 里没有 ${channel}`).toBeDefined();
      expect(row?.priority).toBe(want?.priority);
      expect([...(row?.countries ?? [])]).toEqual([...(want?.countries ?? [])]);
      expect([...(row?.currencies ?? [])]).toEqual([...(want?.currencies ?? [])]);
      expect(row?.label).toBe(want?.label);
      expect(row?.icon).toBe(want?.icon);
    },
  );

  /**
   * @why `icon` 是**可空列**：PG 给的是 `null`，而 `ChannelConfig['icon']` 是 `icon?: string`。
   *      若读取口原样把 `null` 传下去，装配出的 `ChannelConfig.icon` 会是 `null`——
   *      它不等于 undefined，于是 `listAvailable` 里那个 `cfg.icon !== undefined` 判断
   *      会把 `icon: null` 塞进响应（契约里 icon 是可选字符串，**null 不是合法值**）。
   *      这条用例钉住"null 必须在读取口就变成 undefined"。
   */
  it('icon 为 NULL 的列转成 undefined（契约里 icon 是可选字符串，null 不是合法值）', async () => {
    const rows = await loadChannelConfigs(db);
    for (const r of rows) {
      if (r.icon === undefined) continue;
      expect(typeof r.icon).toBe('string');
    }
    // 表里现在三行的 icon 都有值；这条断言的意义在于"读取口不许产出 null"
    for (const r of rows) {
      expect(r.icon === null, `${r.channel} 的 icon 不得是 null`).toBe(false);
    }
  });
});
