/**
 * 职责：一键灌数据的核心逻辑（F9-f）——安全闸门 + 幂等灌入。与 CLI 薄壳（seed.ts）分离，
 *      好让闸门与幂等可以被单测/真库测试直接调用（CLI 入口本身不可测）。
 *
 * @why 三道安全闸门，缺一道都不算"安全的一键"：
 *      ① **只灌本机**：host 必须是 localhost/127.0.0.1/::1。
 *         一键灌数据的全部风险是"对着远程库（尤其 Render 生产）跑了 truncate"——
 *         那一步不可逆。把 host 钉死在本机，"误连生产"在第一步就被拦下。
 *      ② **库名拒 prod**：粗粒度但有效的最后一道（哪怕有人把生产 URL 指到本机代理）。
 *      ③ **清表保留配置表**：truncate 排除 `country_profiles` / `job_runs` / `pgmigrations`——
 *         配置表是"环境的一部分"，清了 dev 库就与生产不同构（与 test-db.ts 同类口径）。
 *
 * @why 幂等靠"先清业务表再灌"而不是 `ON CONFLICT DO NOTHING`：
 *      `ON CONFLICT` 只解决主键撞车，解决不了"上次灌的商品这次从目录里删了、它还赖在库里"。
 *      灌数据的语义就该是"把这个库重置成这份场景的样子"，而不是"往里追加"。
 *
 * @limitation 一：灌的是**无订单的店**（用户/地址/商品/运费档）。订单实体属业务期
 *              （金额勾稽与状态机还没定，见 scenarios.ts @limitation 一）。
 * @limitation 二：清表名单与 `test/db/test-db.ts` 的 `truncateTargets` **同源但各写一份**——
 *              抽公共常量要动测试基础设施，风险高于收益；改一边必须改另一边。
 * @limitation 三：**不做交互确认**（本地工具）。安全完全押在闸门①②上；
 *              若将来要支持灌共享/预发库，必须加 `--allow-remote` + 显式确认，而不是去掉闸门。
 *
 * @see scripts/seed.ts（CLI 入口）；test/factories/scenarios.ts（场景来源）；
 *      test/factories/seed-bundle.ts（入库实现）；seed-lib.unit.test.ts / seed-lib.db.test.ts
 */
import { createRng } from '../test/factories/rng.js';
import { createIds } from '../test/factories/entities.js';
import { demoShop, fullCatalog, type SeedBundle } from '../test/factories/scenarios.js';
import { insertBundle } from '../test/factories/seed-bundle.js';
import type { Db } from '../server/src/adapters/db.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 推导本地 dev 库 URL（当 `DATABASE_URL` 未配置时的回落）。
 * @why "一键"的底线是**零配置**：本地开发不该为了灌数据先抄一串连接串。
 *      角色名与 `test/db/test-db.ts` 的 `localRole()` 同源（USER / LOGNAME → postgres），
 *      库名固定 `japan_shop`（与 dev 约定一致）。安全闸门（本机 + 拒 prod）对推导值同样生效。
 * @limitation 只在 Unix（macOS/Linux）成立；Windows 上 USER/LOGNAME 通常为空 → 回落 `postgres`。
 */
export function defaultDevUrl(): string {
  const role = process.env.USER ?? process.env.LOGNAME ?? 'postgres';
  return `postgresql://${role}@localhost:5432/japan_shop`;
}

/** 闸门①+②：只灌本机、库名拒 prod。不通过就抛错，绝不留"再说一次"的余地。 */
export function assertSafeTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DATABASE_URL 不是合法 URL，拒绝执行（${url.slice(0, 12)}…）`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `拒绝灌非本机库（host=${parsed.hostname}）。一键灌数据只允许对着 localhost，这是不可逆操作的底线。`,
    );
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (/prod|production/i.test(dbName)) {
    throw new Error(`库名 "${dbName}" 看起来像生产库，拒绝执行`);
  }
}

/** 闸门③：清空业务表，保留配置表（country_profiles）与迁移账本、看门狗心跳。 */
export async function clearBusinessTables(db: Db): Promise<number> {
  // 与 test-db.ts 的 truncateTargets 同源（见 @limitation 二）：排除配置表与迁移账本
  const rows = await db`
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename not in ('pgmigrations', 'job_runs', 'country_profiles')
    order by tablename`;
  const tables = rows.map((r) => String(r.tablename));
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`表名形状异常，拒绝拼接：${t}`);
  }
  if (tables.length === 0) throw new Error('库里没有业务表：迁移是不是没跑？先 npm run db:migrate');
  await db.unsafe(`truncate table ${tables.join(', ')} restart identity cascade`);
  return tables.length;
}

export interface SeedResult {
  clearedTables: number;
  bundle: SeedBundle;
  counts: { users: number; addresses: number; products: number; shippingRates: number };
}

/**
 * 灌一次（幂等）：先清业务表，再灌入场景。
 * @param seed 随机源种子；默认固定，让"灌两次"产物完全一致（重复跑是常态，不该越灌越乱）。
 */
export async function seedOnce(
  db: Db,
  opts: { full?: boolean; seed?: string | number } = {},
): Promise<SeedResult> {
  const clearedTables = await clearBusinessTables(db);
  const seedKey = opts.seed ?? 'seed';
  const bundle: SeedBundle =
    opts.full === true
      ? fullCatalog(createRng(seedKey), createIds(seedKey))
      : demoShop(createRng(seedKey), createIds(seedKey));
  const counts = await insertBundle(db, bundle);
  return { clearedTables, bundle, counts };
}
