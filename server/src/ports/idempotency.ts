/**
 * 职责：幂等的**端口契约**（F8）——类型、语义常量，以及"什么算同一个请求"这条判定规则。
 * 边界：只有契约 + 纯函数；SQL、事务、租约续期都在 `adapters/idempotency.ts`。
 *
 * @why 为什么要拆出端口：幂等是"钱"的守门人，业务侧需要的是"这个操作只准执行一次"，
 *      而不是"往 idempotency_keys 表里插一行"。把 SQL 留在业务代码里，换存储
 *      （或加一层缓存）时就要动业务；反过来，契约先行之后业务只认方法名，
 *      实现的任何调整都被挡在适配器里。
 *
 * @limitation 一：**本端口不定义事务句柄的形状**。`runInTx` 的 handler 收到的 `TTx`
 *              是泛型参数，由装配处给定（当前是 postgres.js 的 `Db`）。
 *              这是**已知的不彻底**，不是遗漏：真正的 `Db` 端口要等业务核心（domain）
 *              出现后才提得准，现在造一个"通用查询接口"只会造错
 *              （@see docs/自主决策记录.md AJ-44 反向风险③、AJ-47）。
 *              代价：业务侧目前仍然看得到 `Db` 这个类型名——但只是**类型**，不是实现。
 * @limitation 二：`requestFingerprint` / `scopeKey` 是**纯函数实现**，放在端口里
 *              意味着"ports 不再只有类型"。这是刻意的选择：它们定义的不是工具，
 *              而是契约语义——改了指纹算法就等于改了"什么算同一件事"，
 *              改了 scopeKey 就等于改了键的命名空间（老键会集体失效）。
 *              放在通用 utils 里，这类改动会被当成"无害的工具调整"而溜过 review。
 *              若将来坚持 ports 必须纯接口，正确去处是 `domain/`（domain 可以 import ports，
 *              反过来不行），不是 utils。
 *
 * @see adapters/idempotency.ts（实现与全部设计理由）；migrations/003_idempotency_and_identity.sql；
 *      migrations/004_idempotency_fencing.sql；docs/地基搭建清单.md F8；评审 D3/D4；
 *      docs/二审意见甄别报告-2026-09-23.md §1 N1（栅栏令牌）/ N2（单事务模式）
 */
import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';

/**
 * 占位行的**租约时长**（毫秒）：超过这个时间还没完成的占位，允许被下一个请求接管。
 *
 * @why 没有租约时，进程在"抢到占位之后、写回结果之前"崩溃，那行就永远停在占位态——
 *      同一个幂等键**永久**返回 40903，用户再也下不了这一单（复现缺陷 D3）。
 *      崩溃在小内存实例上是常态（OOM、平台重启、部署），所以这不是理论风险。
 * @why 30 秒而不是更短：必须显著大于 handler 的最坏耗时（下单含运费计算 + 建单 + 写事件，
 *      正常 <1s，最坏几秒）。租约短于 handler 耗时会触发"接管 → 重复执行"这一坏事，
 *      所以宁长勿短（续期机制能进一步缓解，见适配器的 `startRenewal`）。
 */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * 稳定序列化：对象键按字典序排列。
 * @why 直接用 `JSON.stringify` 会让**键顺序不同但内容相同**的两个请求算出不同指纹，
 *      于是"客户端复用幂等键"这个真 bug 抓不到，反而会在正常重放时误报 40908。
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * 请求指纹：任意可序列化入参 → 64 位十六进制串。
 * @why 幂等键只回答"是不是同一件事的重复提交"，回答不了"是不是**同一件事**"（D4）。
 *      客户端复用键（bug 或刻意）时，若不比对内容就直接返回首次结果，
 *      用户会以为自己下了第二单——而实际上第二单从未创建，钱也没收。
 *      这种"静默成功"比报错危险得多：它在日志里长得跟正常重放一模一样。
 */
export function requestFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

/** 按 `用户 + 路由 + 客户端 key` 幂等键的作用域前缀，防止跨用户/跨接口撞键。 */
export function scopeKey(parts: { userId?: string; route: string; clientKey: string }): string {
  return [parts.userId ?? 'anon', parts.route, parts.clientKey].join(':');
}

export interface IdempotencyArgs {
  /** 幂等键（服务端按 {@link scopeKey} 拼好作用域后传入）。 */
  key: string;
  userId?: string | undefined;
  route: string;
  /**
   * 参与指纹的请求素材（通常是 body，含影响结果的关键 query）。
   * @why 不传就**不做指纹校验**——给"确实没有入参"的接口留口子，
   *      但默认应该是传：不传等于放弃 D4 那层保护。
   */
  request?: unknown;
  /** 并发时等待首次结果的时长（毫秒，默认 2000）。 */
  waitMs?: number;
  /** 轮询间隔（毫秒，默认 50）。 */
  pollMs?: number;
  /** 占位租约时长（毫秒，默认 {@link DEFAULT_LEASE_MS}）。测试里设短值来验证接管。 */
  leaseMs?: number;
  /**
   * 租约续期开关（默认开）。handler 执行期间每 `leaseMs/3` 刷新一次 `locked_until`，
   * 把"慢"和"死"区分开：活着的 handler 不会被接管，死掉的才轮到别人。
   * 测试里设 `false` 模拟"事件循环卡死导致续期停滞"（栅栏令牌防的正是这种场景）。
   */
  renew?: boolean;
  /**
   * 日志器：租约易主（`idempotency_lease_lost`）等异常必须落 error——
   * 它意味着"两个持有者同时认为自己是主人"，是并发事故的信号，不能静默。
   * 可选只是因为本层拿不到装配期的 logger；生产调用方（skeleton/业务路由）必须传。
   */
  logger?: Logger;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  /** true = 本次是重放（handler 未执行）；false = 本次真正执行了。 */
  replayed: boolean;
}

/** handler 的返回：HTTP 状态 + 可序列化的响应体。 */
export interface HandlerResult<T> {
  status: number;
  body: T;
}

/**
 * 幂等执行器（业务侧唯一认识的形态）。
 *
 * 两个入口的取舍：**优先 `runInTx`**。
 * - `runInTx`：占位、业务写入、结果写回在**同一个事务**里，崩溃 = 整体回滚，
 *   不存在"业务提交了、幂等行还停在占位"这个中间态。前提是 handler 只做 DB 写入。
 * - `run`：非事务，handler 含**外部副作用**（调支付机构、发邮件）时用。
 *   代价是崩溃会留下占位行，靠租约 + 栅栏令牌兜底（见适配器里的 @limitation）。
 *
 * @typeParam TTx 事务句柄的形状，由装配处给定（当前是 postgres.js 的 `Db`）。
 *
 * @throws {AppError} 40903（重复提交）：首次请求仍在执行且超过 `waitMs` 未出结果
 * @throws {AppError} 40908（幂等键复用但内容不同）：同一个键传了不一样的请求——客户端的 bug
 * @throws {AppError} 50000（idempotency_lease_lost）：仅 `run`——handler 执行期间租约被接管，
 *         本次结果写不回（写了会覆盖新持有者）。租约易主是并发事故，调用方应重试。
 */
export interface IdempotencyExecutor<TTx> {
  /** 非事务模式：handler 可以含外部副作用；崩溃遗留的占位靠租约接管。 */
  run<T>(
    args: IdempotencyArgs,
    handler: () => Promise<HandlerResult<T>>,
  ): Promise<IdempotencyResult<T>>;

  /** 单事务模式（首选）：handler 必须只做 DB 写入，且只能用参数 tx。 */
  runInTx<T>(
    args: IdempotencyArgs,
    handler: (tx: TTx) => Promise<HandlerResult<T>>,
  ): Promise<IdempotencyResult<T>>;
}
