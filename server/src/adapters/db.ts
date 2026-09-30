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
 * @limitation 三：显式 `prepare: false`（AJ-102）。postgres.js 的默认是 `prepare: true`；
 *              直连 Postgres 时开着无害且略快，但一旦将来接入 pgbouncer（transaction pooling），
 *              具名 prepared statement 会跨事务残留并直接报错。本文件此前的注释声称
 *              "prepare: false 默认"——那是**注释失真**（默认实为 true），三次全量审查时被抓出。
 *              现在显式关闭，让"接入连接池不炸"从一句注释变成一行真实配置。
 *              代价：失去 prepared statement 的少量缓存收益——本项目每条 SQL 都走参数化模板、
 *              QPS 极低，收益本就可忽略。
 *
 * @tradeoff 不做查询构造器与 ORM：换来 SQL 完全可见可审；代价是重构字段时要手工找引用（靠 grep + 测试覆盖）。
 *
 * @see docs/地基搭建清单.md F7；技术文档 v0.5 §3（schema）；migrations/001_init.sql
 */
import postgres, { type Sql } from 'postgres';

/**
 * 连接池类型。第二个泛型是**自定义类型解析后的值类型映射**——
 * 因为下面注册了 `int8 → number`，所以这里是 `{ int8: number }` 而不是 `Record<string, never>`；
 * 写成 `never` 会让 `createDb` 的返回值需要 `as unknown as Db` 才能编译通过，
 * 那等于把"我们确实改了类型映射"这件事藏起来。
 */
export type Db = Sql<{ int8: number }>;

/**
 * `sql.json(value)` 的参数类型（驱动定义）。适配器层统一从这里取，
 * 不在各仓储文件里直接 `from 'postgres'`（驱动 import 单一来源）。
 * @why 它是带索引签名的递归联合：**interface 没有隐式索引签名、不可直接赋给它**，
 *      要传接口形状的对象，要么把声明写成 `type`（对象字面量 type 有隐式索引签名），
 *      要么在调用点显式 `as JSONValue`（即"我保证它可 JSON 序列化"）。
 */
export type { JSONValue } from 'postgres';

/**
 * `bigint`（int8）在 pg_type 里的 oid。
 * @why 自定义类型**靠 `from` 里的 oid 匹配，不靠键名**——实测：`types: { int8: {...} }` 与
 *      `{ bigint: {...} }` 效果完全相同，键名只是标签；而 `from: []` 会导致解析器**永远不被调用**
 *      （我第一次探针就踩了这个坑，症状是"配了但没生效"）。oid 20 是 int8 的固定值。
 */
const INT8_OID = 20;

/**
 * int8 → number，**带安全整数守卫**。
 *
 * @why postgres.js 默认把 int8 / numeric 都返回成 **string**（因为 JS number 装不下 64 位）。
 *      于是 `row.items_jpy + row.shipping_jpy` 从"相加"变成"字符串拼接"：
 *      实测 `1000 + 1000` 得到 `"10001000"`——不报错、不崩溃，金额静默变成十倍。
 *      本项目的金额字段（`items_jpy` / `total_jpy` …）全是 BIGINT，且 JPY 金额量级远小于 2^53，
 *      所以解析成 number 是安全的，且与 `shared/money.ts`（用 number 运算）保持一致。
 *
 * @limitation 超出安全整数范围时**抛错而不是返回近似值**：宁可让这一条查询失败，
 *              也不要让 `pg_table_size` 这类大数静默丢精度。真需要大数时，在 SQL 里
 *              显式 `::text` 取回字符串，或在调用点自行 `BigInt()`。
 * @limitation 只覆盖 int8。`numeric`(oid 1700) **刻意保持 string**——汇率要 8 位小数精度，
 *              `Number('0.00670000')` 会在高位精度上丢信息；换算统一走
 *              `shared/money.ts` 的 `toRateInt()`（它接受 string），不要在业务代码里直接 `Number()`。
 * @tradeoff 序列化方向统一 `String(v)`：实测只有真正推断为 int8 的参数才会走这里，
 *              numeric / double / int4 的参数仍由 postgres.js 自行推断（不受影响，已实测）。
 */
export const INT8_AS_SAFE_NUMBER: postgres.PostgresType<number> = {
  to: INT8_OID,
  from: [INT8_OID],
  serialize: (value: number) => String(value),
  parse: (raw: string): number => {
    const asBig = BigInt(raw);
    if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(
        `int8 值超出 JS 安全整数范围（${raw}）：拒绝静默丢精度。` +
          `请在 SQL 里改用 ::text 取回，或在调用点用 BigInt 处理`,
      );
    }
    return Number(asBig);
  },
};

/**
 * 单条语句超时（毫秒）。
 *
 * @why Postgres 默认 `statement_timeout = 0`（不限时）。一条慢查询（缺索引、锁等待、笛卡尔积）
 *      会**永久**占住连接；连接耗尽后表现是"全站下单超时"，而根因在十几分钟前那一条查询里，
 *      从日志上完全看不出来。设了超时，它至少以 `57014 canceling statement due to statement timeout`
 *      的形式报错——能被检索、能被告警（复现缺陷 D20）。
 * @why 15 秒而不是更小：调度器一次批量关单要遍历一批订单并逐条 savepoint，
 *      以及管理端导出/对账类查询都可能超过几秒。宁可"慢查询慢一点但能完成"，
 *      也不要让正常批量任务被自己的超时打断（那会变成另一种静默失败）。
 * @limitation 这是**连接级**设置，对该池上的所有语句生效，包括事务内的每一条。
 *              若将来出现"就是要跑 60 秒"的作业，应在作业内显式 `SET statement_timeout` 覆盖，
 *              而不是把全局值调大——调大等于让所有查询一起失去保护。
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * 锁等待超时（毫秒，N32）。
 *
 * @why statement_timeout 管"语句总共跑多久"，不管"等锁等了多久"——一个长事务持锁不放时，
 *      等待方只能等满 15s，期间所有日志都像"慢"而不是"被堵"。5s 的锁超时把"堵"
 *      提前暴露成 `55P03 lock_not_available`（可被检索、可告警），
 *      也让"排队等锁"的请求把连接让出来去服务别人。
 * @limitation `withIdempotencyTx` 会按等待预算用 `SET LOCAL lock_timeout` 覆盖本值——
 *             两者不冲突：本值是兜底，SET LOCAL 是按需收窄。
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * 空闲事务超时（毫秒，N32）。
 *
 * @why 代码 bug（忘了 await、事件循环卡死）会把事务晾在半开状态：行锁一直扣着，
 *      等待方排队、连接一直占着——从监控上看是"全站变慢"，根因只是一个没提交的事务。
 *      60s 空闲后 PG 自动杀掉这条连接，把"全表锁死"降级成"一条请求失败"。
 * @limitation 正常事务的**语句之间**间隔超过 60s 也会被误杀（如事务内调外部接口）——
 *             这正是"事务内禁止外部调用"（idempotency.ts @limitation 二）要防的形态，
 *             两个约束互相印证；真需要长事务的作业应显式 SET 覆盖。
 */
export const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 60_000;

export interface CreateDbOptions {
  url: string;
  /** 最大连接数（默认 10）。 */
  max?: number;
  /** 连接超时（秒，默认 10）。 */
  connectTimeoutSec?: number;
  /** 单条语句超时（毫秒，默认 {@link DEFAULT_STATEMENT_TIMEOUT_MS}）；0 = 不限时（不推荐）。 */
  statementTimeoutMs?: number;
  /** 锁等待超时（毫秒，默认 {@link DEFAULT_LOCK_TIMEOUT_MS}）。 */
  lockTimeoutMs?: number;
  /** 空闲事务超时（毫秒，默认 {@link DEFAULT_IDLE_IN_TX_TIMEOUT_MS}）。 */
  idleInTxTimeoutMs?: number;
}

/**
 * 创建连接池。
 * @limitation 返回值需要在使用结束后 `end()`；进程退出前未关闭会导致 Jest/Vitest 挂住不退出。
 */
export function createDb(opts: CreateDbOptions): Db {
  return postgres(opts.url, {
    max: opts.max ?? 10,
    connect_timeout: opts.connectTimeoutSec ?? 10,
    // ⚠️ 必须显式 false：postgres.js 默认是 true（注释曾误写为"false 默认"，AJ-102 修正）。
    //    直连无害，但开着就等于把"将来接 pgbouncer 必炸"埋成定时炸弹。
    prepare: false,
    // ⚠️ 必须配 int8 → number：默认返回 string，`a + b` 会变成字符串拼接（金额静默十倍）。
    //    numeric **不**在这里转（保持 string 交给 toRateInt），理由见 INT8_AS_SAFE_NUMBER 的注释。
    types: { int8: INT8_AS_SAFE_NUMBER },
    // 单条语句超时（D20）：作为**连接参数**下发，池里每条连接都带上，
    // 因此新连接（重连、扩容）也不会漏——比"建池后跑一次 SET"可靠（那条 SET 只影响当时的连接）。
    // N32 同源：lock_timeout（等锁 5s）与 idle_in_transaction_session_timeout（闲事务 60s）
    // 也走连接参数，理由相同。
    connection: {
      statement_timeout: opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      lock_timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: opts.idleInTxTimeoutMs ?? DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
    },
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

/**
 * 判定 SQLSTATE **55P03**（`lock_not_available`：等锁超时，不是"锁冲突本身"）。
 *
 * @why 判定只能认 `.code` 上的 SQLSTATE：message 的措辞随 PG 版本/ locale 变，
 *      SQLSTATE 是协议级稳定标识（§2 诚实清单第 3 条：SQLSTATE 只在 `.code` 上，message 里没有）。
 * @why 收在 db.ts 而不是各处各写一份：55P03 有**两种截然相反的含义**，取决于谁在等——
 *      ① 幂等执行器**抢占位**时超时 = "另一个同名请求正在执行"（不是失败，走冲突路径）；
 *      ② handler **业务**里超时 = "我要改的行正被别人持有"（是失败，必须原样抛出或换成业务码）。
 *      两处若各写一份判定，谁改了其中一份都不会报错、只会静默换错语义——集中一处至少让
 *      "有两种含义"这件事只有一个地方要读（@see adapters/idempotency.ts 的 inHandler 分支）。
 * @limitation 只判 55P03 一种。不要把 40P01（死锁检测）也算进来：死锁是 PG 主动牺牲一方，
 *              语义是"请重试整个事务"，与"等锁超时"不是一回事。
 */
export function isLockNotAvailable(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55P03';
}

/** 关闭连接池（测试与优雅关闭用）。 */
export async function closeDb(db: Db): Promise<void> {
  await db.end();
}
