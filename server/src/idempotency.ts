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
 *
 * @tradeoff 用数据库行而不是 Redis：多一个 DB 往返，换来零额外组件（Render 上没有托管 Redis）。
 *           过期清理交给调度器（idempotency_keys.created_at 24h），不在此处做 TTL。
 *
 * @see 技术文档 v0.5 §3（idempotency_keys）；docs/地基搭建清单.md F8；D-29
 */
import { AppError } from './errors.js';
import type { Db } from './db.js';

/** 占位行的状态码：0 表示"抢到了但还没执行完"，不是真实 HTTP 状态。 */
const PENDING_STATUS_CODE = 0;

export interface IdempotencyArgs {
  /** 幂等键（服务端按 `user_id + route + 客户端 key` 作用域拼接后传入）。 */
  key: string;
  userId?: string | undefined;
  route: string;
  /** 并发时等待首次结果的时长（毫秒，默认 2000）。 */
  waitMs?: number;
  /** 轮询间隔（毫秒，默认 50）。 */
  pollMs?: number;
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
 * @throws {AppError} 40903（重复提交）：首次请求仍在执行且超过 `waitMs` 未出结果
 */
export async function withIdempotency<T>(
  db: Db,
  args: IdempotencyArgs,
  handler: () => Promise<HandlerResult<T>>,
): Promise<IdempotencyResult<T>> {
  const waitMs = args.waitMs ?? 2000;
  const pollMs = args.pollMs ?? 50;

  if (await tryClaim(db, args)) {
    try {
      const result = await handler();
      await db`update idempotency_keys set status_code = ${result.status}, response = ${result.body as never} where key = ${args.key}`;
      return { ...result, replayed: false };
    } catch (e) {
      // 删掉占位行：否则一次失败会把这个 key 永久毒化，用户再也下不了单（@limitation 二）
      await db`delete from idempotency_keys where key = ${args.key} and status_code = ${PENDING_STATUS_CODE}`;
      throw e;
    }
  }

  // 已有记录：要么是已完成的结果（直接重放），要么是别人正在执行的占位（轮询等）
  const deadline = Date.now() + waitMs;
  for (;;) {
    const row = await readCompleted(db, args.key);
    if (row !== undefined) {
      return { status: row.status_code, body: row.response as T, replayed: true };
    }
    if (Date.now() >= deadline) {
      throw new AppError(40903, { key: args.key, route: args.route, waited_ms: waitMs });
    }
    await sleep(pollMs);
  }
}

/** 抢占位：成功返回 true（表示"这次该我执行"）。 */
async function tryClaim(db: Db, args: IdempotencyArgs): Promise<boolean> {
  const rows = await db`
    insert into idempotency_keys (key, user_id, route, status_code, response)
    values (${args.key}, ${args.userId ?? null}, ${args.route}, ${PENDING_STATUS_CODE}, '{}'::jsonb)
    on conflict (key) do nothing
    returning key
  `;
  return rows.length > 0;
}

/** 读已完成的结果；占位行或不存在都返回 undefined。 */
async function readCompleted(
  db: Db,
  key: string,
): Promise<{ status_code: number; response: unknown } | undefined> {
  const rows = await db`
    select status_code, response from idempotency_keys
    where key = ${key} and status_code <> ${PENDING_STATUS_CODE}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return { status_code: Number(row.status_code), response: row.response };
}

/** 按 `用户 + 路由 + 客户端 key` 拼作用域，防止跨用户/跨接口撞键。 */
export function scopeKey(parts: { userId?: string; route: string; clientKey: string }): string {
  return [parts.userId ?? 'anon', parts.route, parts.clientKey].join(':');
}
