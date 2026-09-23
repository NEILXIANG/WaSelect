/**
 * 职责：运行日志（流 A）的唯一出口（F5）——结构化 JSON、统一字段、强制脱敏、自动带上下文。
 * 边界：只管"怎么记"；"记什么"（审计流 B、用户行为流 C）在 F7/F10 落库，不在本文件。
 *
 * @why 三条硬要求决定了这个封装的形态：
 *      ① 能通过日志定位问题 → 必须有 trace_id 把一次操作的日志串起来（靠 context.ts 的 ALS 自动注入）；
 *      ② 能捕获代码运行信息 → 统一字段（module/event/duration_ms/result/err）+ JSON 便于检索；
 *      ③ 不丢用户行为 → 事件名 `event` 是一等公民（强制非空），否则日志无法按行为聚合。
 *
 * @limitation 一：脱敏由 `redact()` 统一做，但它对"字符串里嵌着敏感内容"的形态（SQL、回调原文）无能为力——
 *              规范禁止把回调原文写日志，本封装兜不住这种误用（见 redact.ts @limitation 三）。
 * @limitation 二：`event` 非字符串或空串会**抛 TypeError**。这是刻意的硬失败：事件名写错等于这条日志白记，
 *              宁可在测试期炸掉，也不要在生产里产生一堆无法聚合的 `undefined` 事件。
 *              代价：生产若真有这种调用点，会变成 500（被 F6 的全局兜底捕获并记为 50000）。
 * @limitation 三：pino 默认异步写（sonic-boom）。进程被 SIGKILL 时最后几条日志可能丢；
 *              本项目的关单/退款是关键路径，F13 调度器会在关键事件上**额外**落 `order_events`（流 B，同步事务内）。
 * @limitation 四：**不用 pino 的 `mixin` 注入上下文，也不给 child 建 pino 级绑定**（见 createLogger 内注释）。
 *              两者的代价都是：pino 会把两处同名字段**先后写进同一行 JSON**（重复键），
 *              `JSON.parse` 取后者 → 一旦我们漏脱敏一边，明文就会覆盖掉脱敏值，且肉眼在单行 JSON 里看不出来。
 *              副作用：`raw`（逃生舱）不自动带上下文与 child 绑定，需要时调用方自己拼。
 *
 * @tradeoff 自己包一层 `WaLogger` 而不是直接用 pino.Logger：
 *           换来"脱敏与 event 校验无处可绕"（直接拿 raw 写入是唯一逃生舱，且要写理由），
 *           代价是失去 pino 原生 child 的一部分灵活性，用 `child()` 补回来。
 *
 * @see docs/代码注释规范与日志体系设计.md（流 A）、docs/地基搭建清单.md F5、server/src/redact.ts
 */
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { redact } from './redact.js';
import { currentContext } from './context.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 传给日志方法的字段（除 event 外全部可选，且会被脱敏）。 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
  /** 派生一个带固定字段的子日志器（如 `module: 'payment'`），字段会被子日志器自动带上。 */
  child(base: LogFields): Logger;
  /**
   * 逃生舱：绕过封装直接写 pino。**禁止**用于业务日志（会跳过脱敏与 event 校验），
   * 仅给第三方库集成 / 启动期极端场景使用，使用时必须写注释说明理由。
   */
  readonly raw: PinoLogger;
}

export interface CreateLoggerOptions {
  env: 'development' | 'staging' | 'production';
  /** 覆盖默认级别（默认：development=debug，其余=info）。 */
  level?: LogLevel;
  service?: string;
  /** 固定字段（如 version、region）。 */
  base?: LogFields;
  /** 输出目标；默认 stdout。测试注入内存流用。 */
  destination?: DestinationStream;
}

/** 环境 → 默认级别：生产不输出 debug（debug 里常有完整对象，既是噪音也是泄漏面）。 */
export function levelForEnv(env: CreateLoggerOptions['env']): LogLevel {
  return env === 'development' ? 'debug' : 'info';
}

function assertEvent(event: string): void {
  if (typeof event !== 'string' || event.trim().length === 0) {
    throw new TypeError('日志 event 必须是非空字符串——事件名是日志聚合的唯一维度，不能为空');
  }
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? levelForEnv(opts.env);
  const p = pino(
    {
      level,
      // event 作为消息键：pino 会把它提升为 msg 并从对象里移除，日志既可读又可聚合
      messageKey: 'event',
      // ISO 时间（pino 默认是毫秒时间戳，人不可读，也不便于按时间筛选）
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      // 级别用文字而非数字，便于在检索端直接写 level:error
      formatters: { level: (label: string) => ({ level: label }) },
      base: { service: opts.service ?? 'waselect-server', env: opts.env, ...(opts.base ?? {}) },
      // 刻意**不用** mixin 注入上下文：mixin 会在 pino 层再写一份同名字段，
      // 与我们自己在 emit 里注入的那份形成重复键（见 @limitation 四）。上下文改由 emit 单点注入。
    },
    opts.destination,
  );

  /**
   * @param base **已经脱敏过**的固定字段。约定：传入前必须过 `redact()`，emit 不再重复脱敏。
   */
  const make = (pinoLogger: PinoLogger, base: LogFields): Logger => {
    const emit =
      (levelName: LogLevel) =>
      (event: string, fields?: LogFields): void => {
        assertEvent(event);
        // 字段优先级（后者覆盖前者）：child 绑定 < 请求上下文 < 调用点字段 < event。
        // @why event 必须放最后：曾经写成 `{ ...base, event, ...fields }`，调用点传 `{ event: 'x' }`
        //      就能把事件名改掉（复现缺陷 #6）——日志按 event 聚合，事件名被改写等于这条日志从聚合里消失。
        // @why 上下文与调用点字段都要过 redact：`actor: 'admin:bob@example.com'` 这类值键名不敏感、
        //      值敏感（复现缺陷 #4），键名名单制抓不到，只能靠字符串正则兜底。
        const payload: LogFields = {
          ...base,
          ...(redact(currentContext()) as LogFields),
          ...(redact(fields ?? {}) as LogFields),
          event,
        };
        pinoLogger[levelName](payload);
      };
    return {
      trace: emit('trace'),
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      fatal: emit('fatal'),
      // @why base 里存的是**脱敏后**的 extra：曾经这里传的是原始 extra（`{ ...base, ...extra }`），
      //      于是 `log.child({ token: 'sk_live_xxx' })` 的明文会随每次 emit 直接进日志（复现缺陷 #3）。
      //      同时刻意不调 `pinoLogger.child(...)`：否则同一键在 JSON 里出现两次，
      //      pino 侧的绑定与 base 侧的值谁生效取决于序列化顺序，属于不该存在的隐式行为。
      child: (extra: LogFields) => make(pinoLogger, { ...base, ...(redact(extra) as LogFields) }),
      raw: pinoLogger,
    };
  };

  return make(p, {});
}
