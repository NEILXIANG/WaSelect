/**
 * 职责：`catalog.ts` 的**语句级**用例（不需要真库）——只钉"一次快照"这条结构性质。
 *
 * @why DB3-04 的缺陷形态是"两条语句各拿一个快照"，而**两条语句在真库上几乎总是绿的**：
 *      竞态窗口是毫秒级，真库用例跑一万次也未必撞上一次，撞上了也是随机红。
 *      能稳定断言的是**结构**：选承运商与取档必须在**同一条 SQL**里。
 *      结构对了，快照必然是同一个（PG 的语义保证），不需要复现时序。
 *
 * @limitation 只数语句条数、不验 SQL 结果：结果的正确性由 `catalog.db.test.ts`
 *             （D-46 红线向量 + 三种判别结果）在真库上验。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { createCatalogRepo } from './catalog.js';

/** 记录每次调用并把 SQL 原文留下来的假 Db（只关心"发了几条语句"）。 */
function spyDb(): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const db = ((strings: TemplateStringsArray): Promise<unknown> => {
    statements.push(strings.join(' '));
    return Promise.resolve([]);
  }) as unknown as Db;
  return { db, statements };
}

describe('findSoleCarrierShippingJpy（DB3-04）', () => {
  it('🔴 只发**一条**语句：选承运商与取档必须在同一个快照里', async () => {
    const { db, statements } = spyDb();
    await createCatalogRepo(db).findSoleCarrierShippingJpy(1850);

    // ⚠️ 拆回两条语句 ⇒ 中间可夹进一次整表替换提交 ⇒ "配置切换"被报成 40912「超重」
    expect(statements).toHaveLength(1);
  });

  it('这一条里同时含"选承运商"与"取档"两段口径（不是只做了一半）', async () => {
    const { db, statements } = spyDb();
    await createCatalogRepo(db).findSoleCarrierShippingJpy(1850);

    const sql = statements[0] ?? '';
    expect(sql).toContain('distinct carrier'); // 选承运商
    expect(sql).toContain('max_weight_g >='); // 取档（D-46：必须是 >= + 升序取第一行）
    expect(sql).toContain('order by max_weight_g asc');
  });
});
