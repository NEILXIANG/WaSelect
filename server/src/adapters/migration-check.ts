/**
 * 职责：启动期校验"库里执行过的迁移"追平了"代码带的迁移"（第三轮缺口 P1-2，AJ-385）。
 *
 * @why 本机实测：库停在 028、代码已写 029 的列，服务照常启动，`/healthz` `/readyz` 全绿，**所有建单 500**。
 *      生产里 `preDeployCommand` 迁移失败 / 被跳过 / 回滚了代码却没回迁移时是同一个形态，
 *      外部探活看不出来，只能等买家投诉。缺迁移就拒启，问题落在部署那一刻。
 * @why 以**文件名集合**比对而不是"最大编号"：中间漏跑一条（手工补丁、分支合并顺序）同样是缺列。
 * @why 库比代码新（`ahead`）只告警不拒启：只回滚代码时，已执行的加列迁移对旧代码无害（运维手册 §4.1）；
 *      拒启会让"回滚"这条救命路也走不通。
 * @limitation 只比对**名字**，不比对文件内容：执行后再改迁移文件内容不会被发现（node-pg-migrate 也不校验）。
 * @limitation 读的是部署目录里的 `migrations/`：生产从仓库根目录启动（render.yaml `npm start`），目录必在。
 * @see server/src/main.ts（调用点）；test/db/migrations.db.test.ts（账本与目录一一对应的测试侧断言）
 */
import { readdirSync } from 'node:fs';
import type { Db } from './db.js';

/** 目录里的迁移名（去掉 `.sql`，按名字排序）。 */
export function readMigrationNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

export async function checkMigrations(
  db: Db,
  expected: readonly string[],
): Promise<{ missing: string[]; ahead: string[] }> {
  const rows = await db`select name from pgmigrations`;
  const applied = new Set(rows.map((r) => String(r['name'])));
  const want = new Set(expected);
  return {
    missing: expected.filter((n) => !applied.has(n)),
    ahead: [...applied].filter((n) => !want.has(n)).sort(),
  };
}
