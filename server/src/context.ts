/**
 * 职责：请求级上下文传播（F5）——用 AsyncLocalStorage 让 trace_id / req_id / user_id 自动进入每条日志。
 * 边界：只存"日志要用的标识"，不存业务对象；不做请求级缓存。
 *
 * @why 如果 trace_id 要靠函数参数一层层往下传，必然有某层忘了传，那条日志就断了链——
 *      排查支付回调问题时，缺一条日志就得重放整个链路。AsyncLocalStorage 让"每条日志自动带上上下文"，
 *      调用点零负担，也就没有"忘了传"这种失败模式。
 *
 * @limitation 一：ALS 只在**同一个异步链**内传播。跨进程（队列消费者、定时任务）拿不到上游上下文，
 *              必须由调度方显式把 trace_id 存进任务行再 `runWithContext` 包一层（F13 调度器会这么做）。
 * @limitation 二：ALS 有轻微性能开销（每个请求一次 store 切换）。对本项目的量级（日百单）可忽略；
 *              若将来到日十万单量级需要重新评估。
 * @tradeoff 用隐式上下文换取调用点整洁：代价是"日志里为什么会有这个字段"不再是本地可见的，
 *           必须在规范里写明上下文来自中间件，否则后来者会困惑。
 *
 * @see docs/代码注释规范与日志体系设计.md（统一字段）、docs/地基搭建清单.md F5
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** 进入每条日志的统一标识字段（与 docs/代码注释规范与日志体系设计.md 的字段表一致）。 */
export interface LogContext {
  /** 全链路追踪 ID：一次用户操作（下单/支付）从入口到回调共用，用于把散落的日志串成一条链。 */
  trace_id?: string;
  /** 单次 HTTP 请求的 ID：一个 trace 下可能有多次请求（重试、回调）。 */
  req_id?: string;
  /** 用户 ID（内部），未登录时没有。 */
  user_id?: string;
  /** 操作者：小程序用户 / 管理员邮箱 / system（定时任务）。 */
  actor?: string;
  /** 订单号：有订单语义的操作都带上，便于按单聚合。 */
  order_id?: string;
  /** 支付通道：mock / wechat / stripe。 */
  channel?: string;
  /** 模块名：payment / order / scheduler …，用于按模块过滤。 */
  module?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** 当前异步链的上下文（无上下文时返回空对象，绝不是 undefined——避免调用点到处判空）。 */
export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * 在指定上下文中执行 fn；fn 内（含其派生的所有异步操作）的日志都会自动带上这些字段。
 * @param ctx 上下文；若未提供 trace_id 会自动生成，保证"只要有上下文就有 trace_id"
 */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  const merged: LogContext = { trace_id: ctx.trace_id ?? randomUUID(), ...ctx };
  return storage.run(merged, fn);
}

/** 在当前链上补充字段（例如登录成功后才知道 user_id）。无上下文时等价于无操作。 */
export function patchContext(patch: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
}

/** 生成一个新的 trace_id（跨进程传递时用，如把 trace_id 写进任务行）。 */
export function newTraceId(): string {
  return randomUUID();
}
