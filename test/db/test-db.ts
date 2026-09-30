/**
 * 职责：测试库管理（F7）——建库、跑迁移、用例之间清空数据。
 * @why 用**真实 Postgres**而不是内存数据库或 mock：运费分档、CHECK 约束、事务与 savepoint、
 *      唯一索引并发冲突这些行为只有真库才一致。用假库等于把最危险的一类 bug 留到生产才暴露。
 * @limitation 迁移用子进程调 node-pg-migrate CLI（约 1s）。比 API 调用慢，但用的是与生产完全相同的
 *              执行路径（同一份 migration 文件、同一个 CLI），避免"测试走 API、生产走 CLI"两套行为。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { assertPostgresMajor, createDb, type Db } from '../../server/src/adapters/db.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATE_BIN = resolve(root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

/**
 * 加载仓库根的 `.env`（若存在）。
 * @why 用 Node 内置的 `process.loadEnvFile`（21.7+）而不是引 dotenv——
 *      少一个依赖，且行为与 `node --env-file` 一致。已存在的环境变量**不会被覆盖**，
 *      因此 CI 注入的 TEST_DATABASE_URL 优先于 .env。
 */
function loadDotEnv(): void {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}
loadDotEnv();

/**
 * 本地默认角色名。
 * @why 曾经把连接串写成 `postgres://neilxiang@localhost/...`——那是**本机用户名**，
 *      被提交进仓库（.env.example / 测试默认值）。两个后果：① 换台机器/换个人就跑不起来；
 *      ② 把个人标识写进了公开仓库。Homebrew 装的 Postgres 默认就是"当前 OS 用户 + 免密"，
 *      所以从 `USER`/`LOGNAME` 推导既通用又不泄个人信息。
 * @limitation 只在 Unix（macOS/Linux）成立；Windows 上这两个变量通常为空 → 回落 `postgres`。
 */
function localRole(): string {
  return process.env.USER ?? process.env.LOGNAME ?? 'postgres';
}

/**
 * 测试库名按 **vitest project 分库**（`''` = db / contract 等默认层）。
 *
 * @why `npm run cov` 把 unit / db / contract / e2e 四个 project 放进**同一个 vitest 进程并发跑**
 *      （2026-09-30 实测：206 个文件，db 与 e2e 同时各起各的服务）。而 db 与 e2e 都要
 *      `resetTestDb()`（`TRUNCATE` 全部业务表），共库时一方的 `beforeEach` 会把另一方
 *      **正在跑的用例**刚写进去的数据清掉。实测症状（`admin-ops-routes.db.test.ts`）：
 *      ① 两条汇率刚落库后 `count(*) from fx_rates` 读回 0；
 *      ② 刚 seed 的管理员行被清掉，请求拿到 40101「未登录」。
 *      两条**同时**红、都指向"数据没了"，但被测逻辑一个字都没动过。
 *      ⚠️ 这类红灯只在 `cov` 一轮出现（`test:db` 与 `test:e2e` 分步跑都是绿的），
 *      过去被当成"机器慢/偶发"而用放宽超时去缓解——那是把病因挪进抽屉：
 *      超时只能挡住"跑得慢"，挡不住"数据被别人删"。真正的修法是**不共享可变状态**。
 *      @see 本文件 `TEST_DB_URL`（名字一律由本函数决定，不信任外部串里的库名）
 *
 * @limitation 代价：多一个 project 标签 = 多一个库（多一次建库 + 一次迁移，约 1s，仅首次）。
 *              换来的是"任何 project 组合下都不会互删"。若将来再拆 project，加标签即可。
 * @tradeoff 放弃了"所有层共用一个库、跑得快一点"，因为一次 flake 的成本是
 *           一整轮 10 分钟 gate + 一次归因排查，远大于 1s 建库。
 *
 * @param {string} project project 标签；空串 = 默认库。只允许 `[a-z][a-z0-9_]*`
 * @returns {string} 一定以 `_test` 结尾（闸门 `assertIsTestDatabaseUrl` 的硬要求）
 */
export function testDbNameFor(project: string): string {
  // 不 trim：标签来自我们自己的配置，带空格是写错了——静默归一化会让人以为"e2e"生效了
  // 而实际连的是另一个库（分库失效后 flake 会回来，且看不出原因）。写错就响亮失败。
  const p = typeof project === 'string' ? project : '';
  if (p === '') return 'japan_shop_test';
  // 标签会被拼进库名（无法参数化），必须先卡形状——这是 `create database` 的注入面
  if (!/^[a-z][a-z0-9_]*$/.test(p)) {
    throw new Error(
      `测试库 project 标签不合法（只允许小写字母、数字、下划线）：${String(project)}`,
    );
  }
  return `japan_shop_${p}_test`;
}

/** 本进程用的 project 标签（`vitest.config.mts` 里按 project 注入 `TEST_DB_PROJECT`）。 */
const TEST_DB_PROJECT = envOrDefault(process.env.TEST_DB_PROJECT, () => '');

/** 本进程用的测试库名。 */
export const TEST_DB_NAME = testDbNameFor(TEST_DB_PROJECT);

/**
 * 把任意连接串的**库名**换成 {@link TEST_DB_NAME}，主机/端口/角色保持不变。
 *
 * @why 以前 `TEST_DATABASE_URL` 一旦显式设置，库名就以它为准、{@link TEST_DB_NAME} 被忽略——
 *      于是"分库"会在任何配过 `TEST_DATABASE_URL` 的机器上静默失效，
 *      表现是"本地改好了、CI 上照样 flake"。现在无论外部串叫什么，库名一律由本文件决定：
 *      `TEST_DATABASE_URL` 只提供**连到哪里**（主机与凭据），不提供**连哪个库**。
 *      @tradeoff 副作用是 CI 上不能再用 `TEST_DATABASE_URL` 指定一个自定义库名；
 *               可接受——库名是隔离策略的一部分，不该由环境变量覆盖。
 */
function withTestDbName(base: string): string {
  const url = new URL(base.trim());
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

/**
 * 推导测试库连接串：优先从 `DATABASE_URL` 换库名得到（CI 上 DATABASE_URL 指向专用实例，
 * 换库名比另配一个变量更不容易配错），否则用本机 OS 角色名拼一个本地地址。
 */
function deriveTestUrl(): string {
  const base = process.env.DATABASE_URL;
  if (base !== undefined && base.trim().length > 0) {
    return withTestDbName(base);
  }
  return `postgres://${localRole()}@localhost:5432/${TEST_DB_NAME}`;
}

/** 同 {@link deriveTestUrl}，但库名换成 `postgres`（建库/删库用的管理库）。 */
function deriveAdminUrl(): string {
  const base = process.env.DATABASE_URL;
  if (base !== undefined && base.trim().length > 0) {
    const url = new URL(base.trim());
    url.pathname = '/postgres';
    return url.toString();
  }
  return `postgres://${localRole()}@localhost:5432/postgres`;
}

/**
 * 校验"这一串一定指向测试库"。
 *
 * @why `resetTestDb()` 会对库里**所有业务表**执行 `TRUNCATE … CASCADE`。
 *      而 `TEST_DATABASE_URL` 是环境变量，配错一次（比如指到开发库 `japan_shop`）
 *      就会把真实数据全清掉，且**没有任何警告**——这是"一次手滑清零全部数据"级别的风险。
 *      之前的防线只校验了**表名**形状，没校验**库名**，等于门没关上。
 *
 * @limitation 一是"看起来是测试库"的启发式判断，不是权限隔离：
 *              真正的隔离应当由**数据库角色**（测试角色只对 `*_test` 有写权限）来做，
 *              那条要在 CI/生产库上配，本函数只是最后一道廉价保险。
 * @limitation 二：CI 上若把测试库放到独立实例（非 localhost），需显式设 `ALLOW_REMOTE_TEST_DB=1`，
 *              并接受"这串指向的库会被清空"——明文写出来，避免误设。
 */
export function assertIsTestDatabaseUrl(url: string, opts: { allowRemote?: boolean } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`测试库连接串无法解析：${url}`);
  }
  const allowRemote = opts.allowRemote ?? process.env.ALLOW_REMOTE_TEST_DB === '1';
  const name = parsed.pathname.replace(/^\//, '');
  // ⚠️ `new URL('postgres://u@[::1]:5432/x').hostname` 返回 **'[::1]'**（带方括号），
  //    直接和 '::1' 比会把 IPv6 回环判成远端——这条是被自己的用例抓出来的。
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (name.length === 0) throw new Error(`测试库连接串没有指定库名：${url}`);
  if (!name.endsWith('_test')) {
    throw new Error(
      `拒绝使用「${name}」当作测试库：库名必须以 _test 结尾。` +
        `（resetTestDb 会 TRUNCATE 所有业务表；若确实是测试库，请改名或显式设 ALLOW_REMOTE_TEST_DB=1 前先想清楚）`,
    );
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal && !allowRemote) {
    throw new Error(
      `拒绝在非本机主机「${host}」上跑测试：会清空 ${name}。确为专用测试实例请设 ALLOW_REMOTE_TEST_DB=1。`,
    );
  }
  return url;
}

/**
 * 环境变量取值：空串/纯空白按「未设置」处理，回落到 fallback（惰性，有值时根本不调用）。
 *
 * @why 与 config.ts 的约定同源（`.env` 里 `KEY=` 是占位，不是空字符串值）——
 *      但 `??` 拦不住空串。2026-09-25 真实踩到：dev-up 从 .env.example 物化出 .env 后，
 *      `TEST_DATABASE_URL=`（空串）经 loadEnvFile 进入 env，`?? deriveTestUrl()` 放行空串，
 *      `new URL('')` 在**模块加载期**炸掉——任何一个 import 本模块的测试文件全红，
 *      且报错指不向「你的 .env 有个空占位」。
 */
export function envOrDefault(value: string | undefined, fallback: () => string): string {
  return value !== undefined && value.trim().length > 0 ? value : fallback();
}

/** 测试库连接串（与开发库 japan_shop 分开，避免误删真实数据；库名一律取 {@link TEST_DB_NAME}）。 */
export const TEST_DB_URL = assertIsTestDatabaseUrl(
  withTestDbName(envOrDefault(process.env.TEST_DATABASE_URL, deriveTestUrl)),
);
/** 用来建库的管理库连接串（本身不会被清空，但仍要求本机）。 */
const ADMIN_DB_URL = ((): string => {
  const url = envOrDefault(process.env.TEST_ADMIN_DB_URL, deriveAdminUrl);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`管理库连接串指向非本机主机「${host}」，拒绝继续。`);
  }
  return url;
})();

let ready: Promise<void> | undefined;
let cachedTables: readonly string[] | undefined;

/**
 * 跑一次迁移（子进程调 node-pg-migrate）。
 *
 * @why 抽成函数一是为了 `up` 与 `down` 共用同一套错误处理，二是 T7 的
 *      "up → down → up" 用例需要显式指定方向——写死 `up` 就测不了回滚脚本。
 * @limitation 用 `execFileSync` 而不是异步：迁移必须在任何测试用它之前完成，
 *             异步化只会带来"谁等谁"的问题，没有收益。
 */
export function runMigrations(direction: 'up' | 'down', count?: number): void {
  const args = [MIGRATE_BIN, '-m', 'migrations', direction];
  if (count !== undefined) args.push(String(count));
  try {
    execFileSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      // ⚠️ 不能 'ignore'（D29）：迁移失败时**看不到任何原因**，
      //    症状会变成"测试库里没这张表"这种完全指不向迁移的错误，排查方向从一开始就错。
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const detail = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n');
    throw new Error(
      `迁移（${direction}）失败：${err.message ?? String(e)}${detail.length > 0 ? `\n${detail}` : ''}`,
    );
  }
}

/** 确保测试库存在且迁移到最新；进程内只做一次。 */
export function ensureTestDb(): Promise<void> {
  ready ??= (async () => {
    const admin = createDb({ url: ADMIN_DB_URL });
    try {
      const rows = await admin`select 1 as ok from pg_database where datname = ${TEST_DB_NAME}`;
      if (rows.length === 0) {
        // 库名来自配置不是用户输入，无法参数化，只能拼接——这里做一次白名单校验
        if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DB_NAME)) {
          throw new Error(`测试库名不合法：${TEST_DB_NAME}`);
        }
        await admin.unsafe(`create database ${TEST_DB_NAME}`);
      }
    } finally {
      await admin.end();
    }
    runMigrations('up');

    // 版本闸门：库版本不符合要求就在这里炸，而不是让某个 SQL 行为差异变成"偶发红灯"
    const probe = createDb({ url: TEST_DB_URL, max: 1 });
    try {
      await assertPostgresMajor(probe);
    } finally {
      await probe.end();
    }
  })();
  return ready;
}

/**
 * 需要清空的表：**从 information_schema 动态取**，不写死名单。
 * @why 写死名单的失败模式是"加了新表忘了加进名单"——新表的数据会跨用例残留，
 *      表现为"某个用例单跑通过、整套跑就红"，这类幽灵红灯极难归因，
 *      而且必然发生在加新表的人身上（他对残留毫无预期）。动态取表把这个失败模式彻底消除。
 * @limitation 排除三类"不该清空的表"，每类都有独立理由：
 *              ① `pgmigrations` —— 迁移账本，清了会让下一次 migrate 重跑全部迁移；
 *              ② `job_runs` —— 迁移 seed（D-45：清了看门狗永远读不到心跳）；
 *              ③ `country_profiles` / `duty_rates` / `payment_channels` / `app_config` ——
 *                 **配置表，不是业务表**（007 / 010 种子；ADR-28 四张配置表）。
 *                 区分口径：业务表的数据是"用例造出来的"，配置表的数据是"环境的一部分"——
 *                 就像表结构由迁移建、不该被 truncate 一样。清空配置表的后果不是"用例更干净"，
 *                 而是"测试环境与生产环境不再同构"：生产上这张表永远有 US 那条，
 *                 测试上被清空后任何读国家档案的代码都拿到空，于是测试在验一条生产上不存在的行为。
 *              将来若新增"不该清空的字典表"，在这里加白名单并写明属于哪一类。
 * @limitation ⚠️ "配置表不清空"的代价是：**它一旦被清掉，没有任何机制自动补回 seed**。
 *              迁移账本仍记着 007 已应用，于是 `migrate up` 认为无事可做，
 *              表现是"表在、结构在、数据是空的"——读国家档案的代码拿到空而不报错。
 *              补救方式只有一条：对测试库跑一次 `migrations down` 再 `up`（重放 seed）。
 *              2026-09-25 做缺陷注入时就真实踩到过一次（临时把配置表放回清空名单 → 跑完 seed 没了）。
 *              **注入类操作结束后要检查的不只是代码，还有数据库状态。**
 */
async function truncateTargets(db: Db): Promise<readonly string[]> {
  if (cachedTables !== undefined) return cachedTables;
  const rows = await db`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename not in ('pgmigrations', 'job_runs', 'country_profiles', 'duty_rates', 'payment_channels', 'app_config')
    order by tablename`;
  const tables = rows.map((r) => String(r.tablename));
  if (tables.length === 0) {
    // 空名单会让 `truncate table` 变成语法错误或静默无操作，两种情况都比直接报错更难排查
    throw new Error('测试库里没有找到任何业务表：迁移是不是没跑成功？');
  }
  cachedTables = tables;
  return tables;
}

/** 清空业务数据（保留迁移账本与 seed），保证用例之间互不污染。 */
export async function resetTestDb(db: Db): Promise<void> {
  const tables = await truncateTargets(db);
  // 表名来自 pg_tables 且经过 not-in 过滤，但仍是拼接进 SQL 的标识符——逐个做一次形状校验兜底
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`表名形状异常，拒绝拼接：${t}`);
  }
  await db.unsafe(`truncate table ${tables.join(', ')} restart identity cascade`);
}

/** 取一条测试库连接（用例结束后由调用方 closeTestDb 关闭）。 */
export function testDb(): Db {
  return createDb({ url: TEST_DB_URL, max: 4 });
}
