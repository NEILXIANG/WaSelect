/**
 * 职责：数据库连接与事务（F7）——postgres.js 连接池、探活、事务边界。
 * 边界：只管连接与事务；查询与业务规则在各自的仓储模块（F8 起）。
 *
 * @why 选 postgres.js + 显式 SQL：跨境业务里"运费分档取档方向""库存原子扣减"这类逻辑
 *      必须是**人能读懂并 review 的 SQL**，ORM 会把它们藏进抽象层——曾经因 VLOOKUP 取档方向错了半年没发现（D-46）。
 *      显式 SQL 的代价是类型安全靠手写，收益是每条关键 SQL 都能单独拿出来跑、能加注释、能被 DBA 看懂。
 *
 * @limitation 一：连接池 `max` 默认 10。Render Web Starter 内存有限，且本量级用不满；
 *              将来横向扩容时要重新评估（每个实例 10 连接 × 实例数 < Postgres 的 max_connections）。
 * @limitation 二：`withTransaction` 用 postgres.js 的 `begin`，它靠**同一条保留连接**实现，
 *              因此回调里**不能**用外层 `db` 去查询（会取到池里另一条连接，看不到未提交数据，还会自锁）。
 *              约定：事务内只用回调参数 `tx`。
 * @limitation 三：不用 prepared statement 缓存（`prepare: false` 默认）。
 *              pgbouncer 场景下必须关；本项目直连，但保持一致以免将来接入连接池时炸。
 *
 * @tradeoff 不做查询构造器与 ORM：换来 SQL 完全可见可审；代价是重构字段时要手工找引用（靠 grep + 测试覆盖）。
 *
 * @see docs/地基搭建清单.md F7；技术文档 v0.5 §3（schema）；migrations/001_init.sql
 */
import postgres, { type Sql } from 'postgres';

export type Db = Sql<Record<string, never>>;

export interface CreateDbOptions {
  url: string;
  /** 最大连接数（默认 10）。 */
  max?: number;
  /** 连接超时（秒，默认 10）。 */
  connectTimeoutSec?: number;
}

/**
 * 创建连接池。
 * @limitation 返回值需要在使用结束后 `end()`；进程退出前未关闭会导致 Jest/Vitest 挂住不退出。
 */
export function createDb(opts: CreateDbOptions): Db {
  return postgres(opts.url, {
    max: opts.max ?? 10,
    connect_timeout: opts.connectTimeoutSec ?? 10,
    // 不配置 transform：金额一律以整数（BIGINT）进出，不做任何驱动层数值转换（避免隐式取整）
  }) as Db;
}

/**
 * 要求的最小 Postgres 大版本。
 * @why 这是**"与生产一致"**的版本锁定，不是语法要求（迁移用到的 gen_random_uuid / identity 列在 13+ 就有）。
 *      真正要防的是"本地 16、生产 14"这类环境错位：排序规则、JSONB 行为、并行计划的差异
 *      只在数据量上来后才暴露，届时排查成本极高。因此把版本写进代码而不是写进文档。
 * @limitation 只卡下限（>=16）。上限不卡：平台（Render）升级小版本/大版本时不应让启动失败；
 *              若将来出现"只有 16 才对"的特性，再改成区间并在注释里写明原因。
 */
export const MIN_POSTGRES_MAJOR = 16;

/** 读取服务端大版本号（`server_version_num` 形如 160015 → 16）。 */
export async function postgresMajorVersion(db: Db): Promise<number> {
  const rows = await db`select current_setting('server_version_num') as num`;
  const num = Number(rows[0]?.num);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`无法读取 Postgres 版本：server_version_num = ${String(rows[0]?.num)}`);
  }
  return Math.floor(num / 10_000);
}

/**
 * 启动/测试前置断言：版本不足直接抛错，而不是带着隐患跑起来。
 * @returns 实际大版本号（供日志）
 */
export async function assertPostgresMajor(db: Db, min = MIN_POSTGRES_MAJOR): Promise<number> {
  const major = await postgresMajorVersion(db);
  if (major < min) {
    throw new Error(
      `Postgres 版本过低：需要 >= ${min}，实际 ${major}。请升级本地库或设置 DATABASE_URL 指向合规实例`,
    );
  }
  return major;
}

/** 探活：`SELECT 1`。用于 /readyz 与启动自检——连不上库的服务不该接流量。 */
export async function ping(db: Db): Promise<boolean> {
  try {
    const rows = await db`select 1 as ok`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * 在事务里执行 fn：成功提交，抛错回滚。
 * @param fn **必须**只用参数 tx 做查询（见文件头 @limitation 二）
 */
export async function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return (await db.begin(async (tx) => fn(tx as unknown as Db))) as T;
}

/**
 * 事务内的**嵌套**单元（savepoint）。
 *
 * @why 必须为"逐条处理、单条失败不影响整批"提供能力：F13 的超时关单与自动签收要遍历一批订单，
 *      其中一条因状态已变而失败时，不能把整批回滚掉（否则一条坏单会永久卡住所有定时任务）。
 * @limitation 只能在已开启的事务里调用：**嵌套不是 `begin` 而是 `savepoint`**——
 *             postgres.js 的 `begin` 只存在于连接池对象上，事务对象上只有 `savepoint`
 *             （类型定义可证：`begin` 在 Sql、`savepoint` 在 TransactionSql）。
 *             误用 `withTransaction(withTransaction(...))` 会报 "db.begin is not a function"，
 *             这里显式抛错把原因说清楚。
 */
export async function withSavepoint<T>(tx: Db, fn: (sp: Db) => Promise<T>): Promise<T> {
  const capable = tx as unknown as {
    savepoint?: <R>(cb: (sql: unknown) => R | Promise<R>) => Promise<R>;
  };
  if (typeof capable.savepoint !== 'function') {
    throw new Error(
      'withSavepoint 只能在事务内调用：当前连接不支持 savepoint（是不是直接传了连接池？）',
    );
  }
  return capable.savepoint(async (sp) => fn(sp as Db));
}

/** 关闭连接池（测试与优雅关闭用）。 */
export async function closeDb(db: Db): Promise<void> {
  await db.end();
}
