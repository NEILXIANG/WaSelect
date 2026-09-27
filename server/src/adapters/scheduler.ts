/**
 * 职责：调度器在 Postgres 上的两个能力（F13）——**事务级 advisory lock** 与 `job_runs` 心跳。
 *
 * 边界：只有 SQL 与两个工厂。编排（顺序执行、各自 savepoint、提交后分发事件）在 `app/scheduler.ts`，
 *      契约在 `ports/scheduler.ts`。本文件**不知道**有哪些 job，也不认识任何业务表。
 *
 * @why 互斥用 **PG 的 advisory lock** 而不是 Redis / 文件锁 / 表里加一列：
 *      ① 不引入任何新依赖——调度器要"高可用"，就不能依赖一个比它更容易挂的东西；
 *      ② 它是**事务级**的（`pg_try_advisory_xact_lock`）：事务提交或回滚时**自动释放**，
 *         不存在"进程崩了留下没人认领的锁"这种状态。这一条是选它的决定性理由——
 *         调度器最常见的异常就是进程被 OOM / 平台重启杀掉。
 * @why 刻意用 `try_` 版本而不是阻塞版 `pg_advisory_xact_lock`：
 *      抢不到就该**立刻跳过**本轮（另一个实例正在做），而不是排队等——
 *      排队会让"两个实例"退化成"两个实例轮流做同一件事"，日志翻倍、心跳互相覆盖的问题原样存在。
 *
 * @limitation 一：`tryAcquire` **必须**在事务里调用，这是靠**调用方**保证的，类型上拦不住
 *              （`Db` 在事务内外是同一个类型）。不在事务里时 PG 会立刻拿到又立刻释放，
 *              函数返回 true，于是"互斥"静默失效——这是本适配器唯一的失效模式，
 *              所以 `scheduler.db.test.ts` 里的互斥用例**必须**走 `withTransaction`。
 * @limitation 二：锁 ID 由名字经 FNV-1a 压成 32 位，理论上会撞。
 *              两个不同 job 撞键的后果是它们互相排斥（各自隔一轮才跑），不会错数据；
 *              且 job 数量是个位数，概率可忽略。真撞了的表现是"某个 job 隔轮才跑一次"。
 * @limitation 三：`record` 用 `coalesce(excluded.last_success_at, job_runs.last_success_at)` 表达
 *              "失败不动心跳"。它依赖 `last_success_at` **可为 NULL**——若哪天给它加 NOT NULL，
 *              这条会静默变成"失败也更新心跳"（coalesce 拿不到 NULL 就没有第二个分支），
 *              而看门狗会因此失明。改动该列的空值时必须同时改这里。
 *
 * @see ../ports/scheduler.ts（契约与三条口径）；migrations/001_init.sql（job_runs 与 seed，D-45）；
 *      migrations/006_job_runs_trace.sql（trace_id 列）；docs/地基搭建清单.md F13；D-43
 */
import type { Db } from './db.js';
import type { JobRunLog, SchedulerLock } from '../ports/scheduler.js';

/**
 * 锁的命名空间（int4）。
 *
 * @why advisory lock 的键空间是**整个库共享**的：任何一个别的用途（别人的迁移脚本、
 *      将来的后台任务）都可能用 `pg_try_advisory_xact_lock(1)` 这种小整数。
 *      固定一个不寻常的常量，把"调度器这一类锁"圈在自己的范围里。
 *      `0x5741` = 'WA'（WaSelect），取值远大于"随手写的 1/2/3"。
 */
export const LOCK_NAMESPACE = 0x5741;

/** PG advisory lock 的二元组（(int4, int4) 形式）。 */
export interface AdvisoryLockId {
  namespace: number;
  key: number;
}

/**
 * 名字 → 锁 ID（FNV-1a 32 位）。
 *
 * @why 放在**适配器**而不是端口：把字符串压成两个 int4 是**PG advisory lock 的形状**，
 *      不是"调度"的语义；换存储（比如将来真的上了 Redis）这段就没用了，端口不该认识它。
 * @why 用 (int4, int4) 而不是单个 int8：`Db` 把 int8 解析成 number，而 FNV 出来的值经 `| 0`
 *      可能是**负数**，参数化时要额外处理类型推断；两个 int4 明确落在有符号 32 位内，没有歧义。
 *      （哈希本身用 `Math.imul` 算：`h * prime` 在 JS 里会溢出成浮点，结果就不再是 FNV。）
 * @why 这个函数的输出**必须跨进程一致**，所以它不能有任何随机/时间成分；
 *      单测用独立算出的参考向量钉住了这一点（改算法会让升级期的新老实例各锁各的）。
 */
export function advisoryLockKey(name: string): AdvisoryLockId {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime；用 imul 而不是 *（见 @why）
  }
  return { namespace: LOCK_NAMESPACE, key: hash | 0 };
}

/**
 * 事务级互斥。返回的对象是无状态的（不持有连接），可以做成单例。
 *
 * @security 只取锁不解锁——释放由事务边界负责。这是刻意的：多写一行"解锁"就多一处可能忘记的地方，
 *           而忘了的后果是永久停摆。
 */
export function createSchedulerLock(): SchedulerLock<Db> {
  return {
    async tryAcquire(tx, key) {
      const id = advisoryLockKey(key);
      const rows = await tx`
        select pg_try_advisory_xact_lock(${id.namespace}::int, ${id.key}::int) as got
      `;
      return rows[0]?.got === true;
    },
  };
}

/**
 * `job_runs` 心跳。
 *
 * @why 用 `insert … on conflict do update` 而不是先 UPDATE 再看 affected rows：
 *      D-45 的教训是"没 seed 的行 UPDATE 影响 0 行，心跳静默消失"。
 *      upsert 让"这一行存不存在"不再是需要关心的事——迁移 seed 了更好，没 seed 也不会哑火。
 *
 * @why "失败不动心跳"写在 SQL 里（`coalesce`）而不是在 JS 里分两条语句：
 *      两条语句意味着"成功/失败"要在两处各写一遍列名，改列时容易只改一处；
 *      且这条规则与"这一行是否被并发更新"绑在同一条语句里，天然原子。
 *      代价是规则变得不显眼——所以上面 @limitation 三 专门点了它。
 */
export function createJobRunLog(): JobRunLog<Db> {
  return {
    async record(tx, input) {
      await tx`
        insert into job_runs (name, last_success_at, last_error, trace_id, last_processed, updated_at)
        values (
          ${input.name},
          ${input.ok ? input.at : null},
          ${input.error ?? null},
          ${input.traceId ?? null},
          ${input.processed ?? null},
          ${input.at}
        )
        on conflict (name) do update set
          -- 失败时上行写入的是 NULL → coalesce 取旧值，等价于"不动 last_success_at"
          last_success_at = coalesce(excluded.last_success_at, job_runs.last_success_at),
          last_error      = excluded.last_error,
          trace_id        = excluded.trace_id,
          -- ⚠️ 这里**刻意不用 coalesce**：本轮没上报（NULL）必须真的清成 NULL，
          --    "没上报"不能被旧值伪装成"这一轮扫出 N 条"（012 迁移 @why）
          last_processed  = excluded.last_processed,
          updated_at      = excluded.updated_at
      `;
    },
  };
}
