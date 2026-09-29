/**
 * 职责：调度器的**端口契约**（F13）——job 的形状、互斥语义、"一轮 tick 算不算成功"的判定，
 *       以及错误文本的归一化（进 `job_runs.last_error` 与日志）。
 *
 * 边界：只有契约 + 纯函数。**不含** SQL（advisory lock 与心跳在 `adapters/scheduler.ts`），
 *      **不含** setInterval 与编排（在 `app/scheduler.ts`）。
 *
 * @why 调度器为什么也要有端口：D-43 定的是"web 进程内常驻调度器"，而**多进程同时 tick 是常态**
 *      ——Render 扩容、蓝绿发布的重叠期、本地连 staging 库调试，都会让两个进程在同一分钟醒来。
 *      超时关单跑两遍不会重复扣款（有幂等），但它会把心跳打成互相覆盖的两行、把
 *      "本轮处理了 3 条"这类日志翻倍，排查时**无法判断哪个数字是真的**。
 *      互斥必须在契约层就写清"谁拿到锁谁跑"，否则每个写 job 的人都要自己重新想一遍这件事，
 *      而其中一部分人会想错（比如用 Redis、用文件锁、或者干脆不锁）。
 *
 * @why 契约里刻意**不定义事务句柄的形状**：`TTx` 是泛型参数，由装配处给定（当前是 postgres.js 的 `Db`）。
 *      这与 `ports/idempotency.ts` @limitation 一 同源——现在造一个"通用查询接口"只会造错，
 *      真正的 Db 端口要等业务核心成形后才提得准。
 *
 * @limitation 一：本契约只支持**顺序执行**的子任务（一个接一个，各自 savepoint）。
 *              刻意不做并发：同一批订单之间常有依赖（先关单再自动签收），
 *              并行会让"同一条订单被两个 job 同时改"变成需要额外加锁的问题，而它带来的收益是零
 *              ——MVP 每轮只处理几十条，顺序跑是毫秒级。
 * @limitation 二：`JobOutcome.processed` 是**job 自己声明**的数字，本契约不校验它的含义
 *              （关单是"关了几单"，对账是"对了几笔"）。跨 job 求和没有意义，日志里必须带上 job 名。
 *
 * @see adapters/scheduler.ts（advisory lock 与 job_runs 的 SQL）；app/scheduler.ts（编排）；
 *      migrations/001_init.sql（job_runs 表与 'tick'/'daily' seed）；
 *      ../context.ts @limitation 一（定时任务要自己建链，本文件是它的落点）；
 *      docs/地基搭建清单.md F13；D-43（不做 Render Cron Job）；D-45（必须 seed 才有心跳）
 */
import type { LogFields } from '../logger.js';
import { maskText } from '../redact.js';
import type { DomainEvent } from './events.js';

/** `job_runs` 里"分钟级 tick"这一行的名字（迁移里已 seed，D-45）。 */
export const TICK_JOB_NAME = 'tick';

/** 抢锁用的键。契约层只给**字符串**，如何映射成存储层的锁 ID 是实现的事。 */
export const TICK_LOCK_KEY = 'scheduler:tick';

/**
 * `job_runs` 里"每日作业"那一行的名字。
 * @why 与端点（`internal-jobs-routes.ts` 传给 `createSchedulerDeps` 的 name）**同一个值**，
 *      所以端点改用它而不是再写一个 'daily' 字面量——两处字面量各自漂移时，
 *      看门狗会去盯一个不存在的行（静默失明，最坏的一类失效）。
 * @why 从 `app/daily-reconciliation.ts` **上移到本端口**（AJ-196）：B11 之后它有两个消费方
 *      （daily 自己的停滞扫描 + tick 里新加的 daily 看门狗 job），
 *      两处各自写一份 'daily' 就是"盯错了行也不报错"的同一个坑（§2 第 60 条：口径漂移）。
 */
export const DAILY_JOB_ROW_NAME = 'daily';

/**
 * 心跳停滞阈值：**daily**（每日作业，24h 一轮）超过这个小时数没有成功心跳 = 没跑。
 * @why 26 小时而不是 24：cron 触发时刻会有抖动（部署/重试），刚过 24 小时就报警
 *      会把"晚了几分钟"报成"一天没跑"。
 * @why 与 {@link DAILY_JOB_ROW_NAME} 一起上移（AJ-196）：两个看门狗必须用**同一个阈值**，
 *      否则会出现"daily 自己说没事、tick 说停滞"这种自相矛盾的告警，排查的人无从下手。
 */
export const DAILY_STALL_HOURS = 26;

/**
 * daily **从未成功过**（`last_success_at is null`）时，进程至少跑了这么久才算停滞。
 *
 * @why 需要"进程运行多久"这个额外条件：新部署的头 26 小时里 daily 本来就没机会跑，
 *      那时 null 是**正常**的；只有"起来一天多了、daily 一次都没成功"才是故障
 *      （cron 没配 / 密钥轮换后 40101 / 端点没挂载）。
 * @why 与 {@link DAILY_STALL_HOURS} **同值**：两者都是"超过一轮 + 抖动余量"，
 *      分开取值只会多出一个没有人能解释的数字。
 */
export const DAILY_NEVER_RAN_GRACE_HOURS = DAILY_STALL_HOURS;

/**
 * `last_error` 与日志里单条错误的最大字符数。
 *
 * @why Postgres 的 TEXT 能装 1GB，装得下不代表该装：
 *      ① 一个带绑定参数值的 SQL 报错轻易上百 KB，写进 `job_runs` 后每次看门狗查询都要拖回来；
 *      ② 日志侧有单行上限的采集器会**整条丢弃**超长行，于是"失败了"这个事实反而看不到；
 *      ③ 错误详情本就该去日志里按 trace_id 查（本契约会把它写进 `job_runs.trace_id`），
 *         这里只留"一眼能判断要不要深挖"的量。
 * @why 500 而不是 100：job 失败多是 SQL 报错，`ERROR: duplicate key value violates ...`
 *      加上表名与约束名就接近 120 字符，截到 100 会把最有价值的约束名切掉。
 */
export const MAX_ERROR_CHARS = 500;

/** 归一化后确实没有任何内容时的占位（绝不留空串，见 oneLineError 的 @why）。 */
const NO_ERROR_TEXT = '(无错误信息)';

/** job 自己声明的执行结果。 */
export interface JobOutcome {
  /** 本轮实际处理的条目数（含义由 job 定义；0 = 无事可做，不是失败）。 */
  processed: number;
}

/** job 专用日志器：自动带上 `job` / `module` / `actor`。 */
export interface JobLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * 传给 job 的执行上下文。
 *
 * @why `tx` 给的是 **savepoint 里的子节点**而不是整轮事务：
 *      这样 job 抛错时回滚的是它自己那一块，前面 job 的成果保留（清单 F13 的验收项）。
 * @why `emit` 与 `unit-of-work` 的 `Emit` 同形但**语义更窄**：它登记的事件
 *      ① 只有本 job 的 savepoint 成功才成立；② 且要等整轮事务提交之后才分发。
 *      把"emit = 已发生"误解成"emit = 记一笔"，就会造出"数据库回滚了但通知已发出"的幽灵副作用。
 */
export interface JobContext<TTx> {
  tx: TTx;
  emit: (event: DomainEvent) => void;
  /**
   * 本轮 tick 的开始时刻。**同一轮里所有 job 看到同一个值**——
   * 不是各自取一次 `now()`：否则"30 分钟未支付"这类边界在同一轮里会有两个判定基准，
   * 边界订单被处理与否取决于它排在队列的第几个，这种 bug 无法复现。
   */
  startedAt: Date;
  log: JobLogger;
}

export interface SchedulerJob<TTx> {
  /** 进 `job_runs.name` 与日志；同一轮里不得重复。 */
  name: string;
  run(ctx: JobContext<TTx>): Promise<JobOutcome>;
}

/** 子任务成功。 */
export interface JobSuccess {
  name: string;
  ok: true;
  processed: number;
  durationMs: number;
}

/** 子任务失败：`error` 必须是**已归一化（脱敏 + 单行 + 截断）**的文本。 */
export interface JobFailure {
  name: string;
  ok: false;
  error: string;
  durationMs: number;
}

export type JobResult = JobSuccess | JobFailure;

/** 本轮 trace_id：与 `job_runs.trace_id` 一致，用于从心跳行反查这一轮的全部日志。 */
interface TickTrace {
  traceId: string;
  durationMs: number;
}

/**
 * 没抢到锁：本轮由别的实例执行，**不是失败**。
 *
 * @why 刻意做成**没有 `ok` 字段**的类型：如果它也带 `ok`，调用方就会写出
 *      `if (r.ok)` 这种判断，而"没抢到锁"既不是成功也不是失败——
 *      它是"这件事由别人做了"。把两种结果做成判别联合，编译器会逼调用方先判 `acquired`。
 */
export interface SchedulerTickSkipped extends TickTrace {
  acquired: false;
}

/** 抢到锁并执行了：`ok` = 所有子任务都成功。 */
export interface SchedulerTickRan extends TickTrace {
  acquired: true;
  ok: boolean;
  jobs: readonly JobResult[];
}

export type SchedulerTickResult = SchedulerTickSkipped | SchedulerTickRan;

/**
 * 事务内互斥。
 *
 * @why 方法签名带 `tx` 是在**强制**一个实现约束：锁必须在事务内取，
 *      这样事务提交或回滚时锁自动释放（PG 的 `pg_try_advisory_xact_lock`）。
 *      若做成"先取锁再开事务"，进程在两者之间崩溃就会留下一把**没有主人**的锁，
 *      此后所有 tick 永久停摆，且从日志上看不出来（ manifests as "定时任务不跑了"）。
 * @tradeoff 事务级锁的代价是**锁的持有期 = 事务时长**，因此事务里禁止外部调用
 *      （与 `adapters/idempotency.ts` 的同名约束同源）。换来的是"不可能漏释放"。
 */
export interface SchedulerLock<TTx> {
  /** @returns true = 本实例拿到锁，可以执行；false = 别人在跑，跳过本轮。 */
  tryAcquire(tx: TTx, key: string): Promise<boolean>;
}

/** 一次心跳记录（写 `job_runs`）。 */
export interface JobRunRecord {
  name: string;
  ok: boolean;
  /** 归一化后的错误文本；ok=true 时传 undefined（会被清成 NULL，而不是留着上次的错误）。 */
  error?: string | undefined;
  traceId?: string | undefined;
  /**
   * 本轮处理条数（写 `job_runs.last_processed`，012 迁移）。
   *
   * @why 让"跑出了什么"和"跑没跑完"落在同一行：看门狗盯 `job_runs` 时，
   *      只看到 `last_success_at` 是看不出异常的（对账扫出 3 条异常时 job 本身是**成功**的）。
   * @why 可选 + NULL 而不是默认 0：「本轮没上报」与「本轮 0 条」必须是两个值
   *      （012 @why）——把 NULL 当 0，就会把"没跑/没上报"读成"没有问题"。
   * @limitation 语义按 job 而定：对账 job 里它是**异常条数**（0 = 好消息），
   *             关单 job 里它是**关掉的单数**。别把它当错误计数——错误在 `last_error`。
   */
  processed?: number | undefined;
  at: Date;
}

export interface JobRunLog<TTx> {
  /**
   * upsert 一行心跳。
   *
   * @why `ok=false` 时**只更新 last_error，不动 last_success_at**（清单 F13 验收项）：
   *      `last_success_at` 是看门狗唯一的依据。若部分失败也更新它，运维看到的是
   *      "刚刚还成功过"，而实际上某个 job 已经连续失败一整天——这是最贵的那类静默失效。
   */
  record(tx: TTx, input: JobRunRecord): Promise<void>;
}

/**
 * 把任意异常压成**一行、已脱敏、有上限**的文本。
 *
 * @why 这个函数放在**端口**而不是实现里，理由与 `ports/webhooks.ts` 的 `payloadHash` 相同：
 *      它定义的不是工具，而是**"last_error 这一列长什么样"**。改了它，历史所有心跳行的含义就变了。
 *      放进 utils 会被当成无害的字符串处理函数，改它的人不会想到自己在改一条持久化口径。
 *
 * @security 走 `maskText`：错误原文里常带 SQL 绑定值（邮箱、电话、订单里的地址），
 *           而 `job_runs.last_error` 是**库里的字段**——写进去就是持久化，不是"打印一下"。
 *           logger 不做自动脱敏（已核实），所以这里必须自己脱。
 *
 * @limitation 只压 message，不带 stack。栈要去日志里按 trace_id 看；
 *             把栈塞进 last_error 会让这一列变成几百行的噪音，且栈里同样可能有敏感值。
 */
export function oneLineError(err: unknown, max: number = MAX_ERROR_CHARS): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  const flat = maskText(raw).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return NO_ERROR_TEXT;
  return flat.length <= max ? flat : `${flat.slice(0, max)}…（已截断，共 ${flat.length} 字符）`;
}

/** 本轮是否全部子任务成功（空列表视为成功——没有子任务就没有失败）。 */
export function allJobsOk(results: readonly JobResult[]): boolean {
  return results.every((r) => r.ok);
}

/**
 * 汇总失败信息（进 `last_error` 与告警）。
 * @returns 全部成功时返回 undefined（调用方据此把 last_error 清成 NULL）
 */
export function aggregateJobError(results: readonly JobResult[]): string | undefined {
  const failed = results.filter((r): r is JobFailure => !r.ok);
  if (failed.length === 0) return undefined;
  const detail = failed.map((r) => `${r.name}: ${r.error}`).join(' | ');
  return `${failed.length}/${results.length} 个子任务失败 → ${detail}`;
}
