/**
 * 职责：幂等执行器（F8）——同一个 Idempotency-Key 只真正执行一次，重放返回首次结果。
 * 边界：只管"执行一次"这件事；key 从哪个头来、哪些路由需要幂等，由路由层决定。
 *
 * @why 支付链路里重试是常态：网络抖动、用户狂点、前端超时重发。
 *      没有幂等，一次"用户以为没成功"的重试就会建出第二张单、扣第二次款——
 *      跨境场景下退款要跨机构、跨币种，纠错成本远高于下单时多写几十行代码。
 *
 * @limitation 一：并发靠**唯一约束抢占位**（status_code=0 的占位行）而不是分布式锁。
 *              第二个请求进来时若占位行还在且未完成，它只能"轮询等结果"；等不到就返回 40903。
 *              后果：极慢的首次请求（超过 `waitMs`）会让并发的第二次拿到 40903 而不是结果——
 *              这是刻意的：宁可让前端明确提示"处理中"，也不要让它重复下单。
 * @limitation 二：handler 抛错时会**删掉占位行**，让同 key 可以重试。
 *              代价：如果 handler 已经产生了副作用（比如已调通支付机构）才抛错，重试会造成重复调用。
 *              约定：handler 必须自身可重入（用 provider 侧的幂等键），本层只保证"不留下毒记录"。
 * @limitation 三：`response` 存 JSONB，因此 handler 的返回必须是可序列化对象（不能是流/函数）。
 * @limitation 四：**租约到期后的接管不保证"原持有者已经死了"**（D3 的固有代价）。
 *              若首次请求只是慢（而非崩溃），租约一到第二个请求就会接管并**再执行一次** handler。
 *              这是"永久卡死"与"偶发重复"之间的取舍：前者必然发生且不可逆，后者只在
 *              "handler 超过租约时长"时才发生，且可以通过把租约设得比 handler 的最坏耗时更长来避免。
 *              真要杜绝仍需 handler 自身可重入（同 @limitation 二）。
 *
 * @tradeoff 用数据库行而不是 Redis：多一个 DB 往返，换来零额外组件（Render 上没有托管 Redis）。
 *           过期清理交给调度器（idempotency_keys.created_at 24h），不在此处做 TTL。
 *
 * @see 技术文档 v0.5 §3（idempotency_keys）；docs/地基搭建清单.md F8；D-29；评审 D3/D4
 */
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
import type { Db } from './db.js';

/** 占位行的状态码：0 表示"抢到了但还没执行完"，不是真实 HTTP 状态。 */
const PENDING_STATUS_CODE = 0;

/**
 * 占位行的**租约时长**（毫秒）：超过这个时间还没完成的占位，允许被下一个请求接管。
 *
 * @why 没有租约时，进程在"抢到占位之后、写回结果之前"崩溃，那行就永远停在占位态——
 *      同一个幂等键**永久**返回 40903，用户再也下不了这一单（复现缺陷 D3）。
 *      崩溃在小内存实例上是常态（OOM、平台重启、部署），所以这不是理论风险。
 * @why 30 秒而不是更短：必须显著大于 handler 的最坏耗时（下单含运费计算 + 建单 + 写事件，
 *      正常 <1s，最坏几秒）。租约短于 handler 耗时会触发"接管 → 重复执行"这一坏事
 *      （见 @limitation 四），所以宁长勿短。
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

export interface IdempotencyArgs {
  /** 幂等键（服务端按 `user_id + route + 客户端 key` 作用域拼接后传入）。 */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 以幂等方式执行 handler。
 *
 * @throws {AppError} 40903（重复提交）：首次请求仍在执行（租约未过期）且超过 `waitMs` 未出结果
 * @throws {AppError} 40908（幂等键复用但内容不同）：同一个键传了不一样的请求——客户端的 bug
 */
export async function withIdempotency<T>(
  db: Db,
  args: IdempotencyArgs,
  handler: () => Promise<HandlerResult<T>>,
): Promise<IdempotencyResult<T>> {
  const waitMs = args.waitMs ?? 2000;
  const pollMs = args.pollMs ?? 50;
  const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
  const hash = args.request === undefined ? '' : requestFingerprint(args.request);
  const deadline = Date.now() + waitMs;

  for (;;) {
    // ① 抢占位（新键）或接管过期占位（崩溃遗留）——两条路径都可能拿到执行权
    if (await claim(db, args, hash, leaseMs)) {
      try {
        const result = await handler();
        await db`
          update idempotency_keys
             set status_code = ${result.status},
                 response = ${result.body as never},
                 completed_at = now(),
                 locked_until = null
           where key = ${args.key}
        `;
        return { ...result, replayed: false };
      } catch (e) {
        // 删掉占位行：否则一次失败会把这个 key 永久毒化，用户再也下不了单（@limitation 二）
        await db`delete from idempotency_keys where key = ${args.key} and completed_at is null`;
        throw e;
      }
    }

    // ② 没抢到：要么已有结果（重放），要么别人正在做（等到租约过期或超时）
    const row = await readRow(db, args.key);
    if (row !== undefined && row.completed_at !== null) {
      // 指纹不符 = 客户端拿同一个键发了**另一个**请求：必须报错而不是返回首次结果（D4）
      if (hash !== '' && row.request_hash !== '' && row.request_hash !== hash) {
        throw new AppError(40908, { key: args.key, route: args.route });
      }
      return { status: row.status_code, body: row.response as T, replayed: true };
    }
    if (Date.now() >= deadline) {
      throw new AppError(40903, { key: args.key, route: args.route, waited_ms: waitMs });
    }
    await sleep(pollMs);
  }
}

/**
 * 抢执行权：插入新占位，或接管"已完成时间为空且租约已过期"的遗留占位。
 *
 * @why 接管用 `UPDATE ... WHERE ... RETURNING` 而不是"先查再插"：后者两步之间有竞态，
 *      两个等待者可能同时判定"租约过期"然后都去执行。Postgres 的 UPDATE 在
 *      `locked_until < now()` 这一行条件上是原子的，第二个 UPDATE 匹配不到行（租约已被刷新）。
 */
async function claim(
  db: Db,
  args: IdempotencyArgs,
  hash: string,
  leaseMs: number,
): Promise<boolean> {
  const lockedUntil = new Date(Date.now() + leaseMs);
  const inserted = await db`
    insert into idempotency_keys (key, user_id, route, status_code, response, request_hash, locked_until)
    values (${args.key}, ${args.userId ?? null}, ${args.route}, ${PENDING_STATUS_CODE}, '{}'::jsonb, ${hash}, ${lockedUntil})
    on conflict (key) do nothing
    returning key
  `;
  if (inserted.length > 0) return true;

  const taken = await db`
    update idempotency_keys
       set locked_until = ${lockedUntil}, request_hash = ${hash}
     where key = ${args.key}
       and completed_at is null
       and (locked_until is null or locked_until < now())
     returning key
  `;
  return taken.length > 0;
}

interface IdempotencyRow {
  status_code: number;
  response: unknown;
  request_hash: string;
  completed_at: Date | null;
  locked_until: Date | null;
}

/** 读整行（含指纹与租约）；不存在返回 undefined。 */
async function readRow(db: Db, key: string): Promise<IdempotencyRow | undefined> {
  const rows = await db`
    select status_code, response, request_hash, completed_at, locked_until
      from idempotency_keys where key = ${key}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    status_code: Number(row.status_code),
    response: row.response,
    request_hash: String(row.request_hash),
    completed_at: row.completed_at as Date | null,
    locked_until: row.locked_until as Date | null,
  };
}

/** 按 `用户 + 路由 + 客户端 key` 拼作用域，防止跨用户/跨接口撞键。 */
export function scopeKey(parts: { userId?: string; route: string; clientKey: string }): string {
  return [parts.userId ?? 'anon', parts.route, parts.clientKey].join(':');
}
