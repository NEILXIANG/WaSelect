/**
 * 职责：**配置上限 ↔ 数据库列宽** 的同源断言（全量审查 B32 / 第七节机制 3 的首个登记表）。
 *
 * @why 全量审查 B32（2026-09-29）：`orders.terms_version` 的列宽在迁移 008 里是 32，
 *      而配置层的上界是**另写的一个数**（最初压根没有上界）。两个真源一旦漂移，
 *      失效形态特别阴：服务启动全绿、健康检查通过、`/terms` 照常下发，
 *      直到**第一笔建单**才在写库时撞 22001。也就是说它躲过了所有启动期护栏，
 *      只在最贵的那条写路径上炸。
 *
 * @why 用 `information_schema` 读列宽、**不把 32 再抄一遍**到测试里：
 *      抄一遍就又多一个真源——这次是"测试以为是 32、DDL 已经改成 64"，
 *      于是配置层放心地拒绝 40 字符的合法值，而谁都不报错。
 *      让测试从库里问"你这个列到底多宽"，改 DDL 的那天这条断言会自己变红，
 *      逼人回来同步 config 的上界。
 *
 * @limitation 一：**目前只登记了一对**（`TERMS_VERSION` ↔ `orders.terms_version`）。
 *              报告第七节机制 3 要的是"新增写字段必须登记"——本文件是那张登记表的第一个条目，
 *              表本身还没强制"新字段必须登记"（那是批次四的活）。
 *              现在它能守住的是：**已登记的这一对永不漂移**。
 * @limitation 二：只覆盖"配置项写进库列"这一类。请求体字段的长度校验（B24 的那一大批）
 *              属 domain 层，不进这张表——它们的真源是契约 `maxLength`，将来另立一处。
 *
 * @see migrations/008_widen_terms_version.sql（列宽的 DDL 真源）；
 *      server/src/config.ts（TERMS_VERSION 的 @limitation 里写了"两处各写一份"）；
 *      docs/全量逐行代码审查报告-2026-09-29.md（ORD-08 / B24 / B32 同源）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import type { Db } from './adapters/db.js';
import { ensureTestDb, testDb } from '../../test/db/test-db.js';

let db: Db;
beforeAll(async () => {
  await ensureTestDb();
  db = testDb();
}, 30_000);
afterAll(async () => {
  await db.end();
});

/**
 * 登记表："配置项 → (表, 列)"。
 * @why 显式列表而不是扫全库：扫全库会撞上大量"本来就没有对应配置项"的列，
 *      于是要么满屏误报、要么加一大堆豁免，两种都会让机制失效
 *      （没有原因的豁免会让清单失效，与 db.db.test.ts 的结构不变量同一条纪律）。
 */
const COLUMN_BOUNDS = [
  { configKey: 'TERMS_VERSION', table: 'orders', column: 'terms_version' },
] as const;

/** 从 information_schema 读列的字符上限（VARCHAR(n) → n；TEXT → null）。 */
async function columnMaxLength(table: string, column: string): Promise<number | null> {
  const rows = await db`
    select character_maximum_length as n
      from information_schema.columns
     where table_schema = 'public' and table_name = ${table} and column_name = ${column}
  `;
  const v = rows[0]?.['n'];
  return v === null || v === undefined ? null : Number(v);
}

const baseEnv: Record<string, string> = {
  DATABASE_URL: 'postgresql://app@localhost:5432/japan_shop',
  JWT_SECRET: 'a'.repeat(32),
  PAYMENT_CHANNELS: 'mock',
};

describe('配置上限与列宽同源（B32）', () => {
  it('登记表非空且能真的读到列宽（防"表空了 → 全绿"）', async () => {
    // @why 第三次以上踩同一形态：登记表被清空 / 解析失效时，下面的断言全部永真。
    //      钉住"至少一对、且这一对的列宽读得到"。
    expect(COLUMN_BOUNDS.length).toBeGreaterThan(0);
    const width = await columnMaxLength(COLUMN_BOUNDS[0].table, COLUMN_BOUNDS[0].column);
    expect(width).toBe(32);
  });

  it('TERMS_VERSION：配置上界恰好等于列宽——列宽内的值放行，超 1 个字符即拒启', async () => {
    const width = await columnMaxLength('orders', 'terms_version');
    expect(width).toBeGreaterThan(0);
    const n = width as number;

    // 恰好等于列宽 → 必须放行（上界写小了会把合法值拦死）
    expect(() => loadConfig({ ...baseEnv, TERMS_VERSION: 'T'.repeat(n) })).not.toThrow();

    // 超 1 个字符 → 必须拒启（上界写大了等于没有上界，又会回到"建单才炸"）
    let thrown: unknown;
    try {
      loadConfig({ ...baseEnv, TERMS_VERSION: 'T'.repeat(n + 1) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, `TERMS_VERSION 长度 ${n + 1} 应被拒（列宽 ${n}）`).toBeDefined();
    // ⚠️ 断言 `issues` 而不是 `message`：ConfigError 的 message 是固定的"配置校验失败"，
    //    字段级原因在 issues 里——只查 message 会让"因为别的字段被拒"也绿。
    expect((thrown as ConfigError).issues.join('\n')).toContain('TERMS_VERSION');
  });
});
