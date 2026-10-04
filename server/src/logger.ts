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
import { capForLog, redact } from './redact.js';
import { currentContext } from './context.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 传给日志方法的字段（除 event 外全部可选，且会被脱敏）。 */
export type LogFields = Record<string, unknown>;

/**
 * 调用点**不得**提供的保留键——身份与归属字段。
 *
 * @why 日志的价值在于**可被信任**：trace_id 串链、user_id/actor 追责、module 过滤。
 *      如果任意一行 `log.info(..., { trace_id: 'FORGED' })` 都能改写它们，日志系统就会自己说谎，
 *      而且**看不出来**——出事后按 trace_id 查出来的链是假的，比没有日志更糟（复现缺陷 D8/D9）。
 *      这些字段只能由**上下文中间件**（请求级身份）或 **child 绑定**（模块级归属）决定。
 *
 * @why **刻意不含** `order_id` / `channel`：这两个是业务维度，且 `log.info('order_created', { order_id })`
 *      是最高频的合法写法（下单那一刻上下文里还没有 order_id）。把它们列成保留键会让正常代码报错，
 *      属于"为了纯洁性牺牲可用性"——它们的取值冲突危害也小得多（最多是归因错一行，不会让链断掉）。
 *
 * @tradeoff 保留了"调用点字段覆盖一切"的灵活性，换来身份字段的可靠性。
 *           想记"另一个用户"就用 `target_user_id`——多一个键名，比让聚合字段可被改写便宜得多。
 *
 * @limitation 一：只挡**顶层**键。`{ ctx: { trace_id: 'x' } }` 这种嵌套不会被拦
 *             （嵌套里的 trace_id 本就不参与聚合，语义上是数据不是字段；拦了会误伤"把上下文整个打出来"的排障写法）。
 * @limitation 二：`order_id` / `channel` 仍遵循"上下文 > 调用点"，即上下文有值时调用点的值会被**静默忽略**。
 *             这是既有优先级规则的延续；若哪天出现"同一个请求里记两个订单"的需求，应改用 `related_order_id`。
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  // 请求级身份：由上下文中间件写入，调用点改了链就断了
  'trace_id',
  'req_id',
  // 归属：审计与过滤的维度，必须可信
  'user_id',
  'actor',
  'module',
  // 基础设施字段：pino 或 base 负责，调用点绝不能碰
  'service',
  'env',
  'level',
  'ts',
]);

/**
 * 静默丢弃的键：`event`。
 * @why 与保留键不同，**不改名、不留痕、不抛错**——事件名由方法参数唯一决定，
 *      调用点传 `{ event: 'x' }` 一律当作没写（缺陷 #6 确立的行为）。
 *      若在这里抛错，会把"多传了一个字段"变成"请求失败"，收益与代价不成比例。
 */
const SILENT_DROP_KEYS: ReadonlySet<string> = new Set(['event']);

/**
 * child() 的**合法身份通道**——这些保留键允许由 child 绑定，不受保留键约束。
 *
 * @why 与调用点不同，child 是身份系统的一等通道（见 RESERVED_KEYS @why 第一句），但只能绑两样：
 *      - `module`：模块归属本来就是 child 的职责（D9 确立了它优先于上下文）；
 *      - `actor`：调度器 / 启动期 / 脚本这类**没有请求上下文**的地方，actor 没有任何其他来源，
 *        禁止 child 绑定等于让这批日志永远没有追责维度。
 * @why 其余保留键**刻意不开放**：trace_id / req_id 必须由 `runWithContext()` 在每一跳开头现取
 *      （调度器每个 job 建自己的链），user_id 由登录态决定，service/env/level/ts 是基础设施字段——
 *      允许 child 绑定它们，等于允许一段代码永久伪造一整片日志的身份，且无上下文处无人能纠正（N30）。
 */
const CHILD_BINDABLE_KEYS: ReadonlySet<string> = new Set(['module', 'actor']);

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
  env: 'development' | 'staging' | 'test' | 'production';
  /** 覆盖默认级别（默认：development=debug，其余=info）。 */
  level?: LogLevel;
  service?: string;
  /** 固定字段（如 version、region）。 */
  base?: LogFields;
  /** 输出目标；默认 stdout。测试注入内存流用。 */
  destination?: DestinationStream;
}

/**
 * 环境 → 默认级别：生产不输出 debug（debug 里常有完整对象，既是噪音也是泄漏面）。
 * `test` 与 `development` 同级（debug）——测试里要看全字段才定位得到问题。
 */
export function levelForEnv(env: CreateLoggerOptions['env']): LogLevel {
  return env === 'development' || env === 'test' ? 'debug' : 'info';
}

function assertEvent(event: string): void {
  if (typeof event !== 'string' || event.trim().length === 0) {
    throw new TypeError('日志 event 必须是非空字符串——事件名是日志聚合的唯一维度，不能为空');
  }
}

/**
 * 把调用点字段拆成「可用字段」与「被丢弃的保留键」，后者改名为 `field_<key>` 保留下来。
 *
 * @why 直接丢掉会让调用方"记了但查不到"，排查时误以为日志系统丢了数据；
 *      改名保留既不污染聚合字段，又留下线索。同行的 `reserved_dropped` 数组让这件事**可在日志里被检索**。
 * @returns dropped 为空表示没有违规
 */
function splitReserved(
  fields: LogFields,
  allow: ReadonlySet<string> = new Set(),
): { safe: LogFields; dropped: string[] } {
  const safe: LogFields = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (SILENT_DROP_KEYS.has(key)) continue;
    if (RESERVED_KEYS.has(key) && !allow.has(key)) {
      dropped.push(key);
      safe[`field_${key}`] = value;
    } else {
      safe[key] = value;
    }
  }
  return { safe, dropped };
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
   * 是否"严格模式"：**仅** development / test 下调用点传保留键直接抛错。
   *
   * @why 两种环境的最优解不同，这不是偷懒而是有理由的两套行为：
   *      - 开发 / 测试：越早炸越好。一个 `log.info('x', { trace_id })` 在测试里就报错，
   *        五分钟能改完；上线后它只会静默地污染聚合字段，可能几个月后才在一次事故复盘里被发现。
   *      - 生产 / 预发：**一条日志绝不能让请求失败**。为了日志字段的纯洁性把下单接口打挂，
   *        是典型的"监控害死业务"——所以改为改名留痕（见 splitReserved），行为不变、可检索。
   * @why N23：staging **刻意与生产同组**而不与开发同组——预发存在的全部意义是预演生产路径
   *      （接真实渠道、跑真实数据彩排）。staging 抛错等于预发跑的不是生产那套行为：
   *      彩排时违规把请求打挂，或者彩排没踩到的路径上线后才露出另一副面孔。
   *      "早炸"有 development/test 两层兜底，不需要第三层。
   * @limitation 生产与预发里的违规不会实时告警，只能靠检索 `reserved_dropped` 发现。
   *             若将来接了 Sentry，这里可以顺手 `raw.warn` 一次（注意别递归）。
   */
  const strict = opts.env === 'development' || opts.env === 'test';

  /**
   * @param base **已经脱敏过**的固定字段。约定：传入前必须过 `redact()`，emit 不再重复脱敏。
   */
  const make = (pinoLogger: PinoLogger, base: LogFields): Logger => {
    const emit =
      (levelName: LogLevel) =>
      (event: string, fields?: LogFields): void => {
        assertEvent(event);
        // @why 上下文与调用点字段都要过 redact：`actor: 'admin:bob@example.com'` 这类值键名不敏感、
        //      值敏感（复现缺陷 #4），键名名单制抓不到，只能靠字符串正则兜底。
        // ⚠️ 两处都要 `capForLog`（CAT2-03）：redact 只管"敏感不敏感"，不管"多长"。
        //    客户端可控的串（路径段、user-agent、原样进 details 的路径参数）长度无界，
        //    限长必须在**日志出口**这一处做——放进 redact 会连审计落库值一起截（见 capForLog 的 @why）。
        const ctx = capForLog(redact(currentContext())) as LogFields;
        const { safe, dropped } = splitReserved(capForLog(redact(fields ?? {})) as LogFields);
        if (dropped.length > 0) {
          if (strict) {
            throw new TypeError(
              `日志调用点不得提供保留键 ${dropped.join(', ')}：` +
                '这些字段由请求上下文或 logger.child() 决定，改写了日志就不可信。' +
                '要记"另一个对象"请换键名（如 target_user_id / related_order_id），要改身份请用 patchContext()。',
            );
          }
          // 生产：不抛错，但必须留痕——否则这类调用永远不会被发现
          safe.reserved_dropped = dropped;
        }

        // 字段优先级（后者覆盖前者）：child 绑定 < 请求上下文 < 调用点安全字段 < event < module 例外。
        // @why event 必须放最后：曾经写成 `{ ...base, event, ...fields }`，调用点传 `{ event: 'x' }`
        //      就能把事件名改掉（复现缺陷 #6）——日志按 event 聚合，事件名被改写等于这条日志从聚合里消失。
        const payload: LogFields = {
          ...base,
          ...ctx,
          ...safe,
          event,
        };
        // @why module 是**唯一的例外**：child 绑定优先于上下文（复现缺陷 D9）。
        //      HTTP 中间件曾经往上下文写 `module: 'http'`，于是请求内 `log.child({ module: 'payment' })`
        //      产出的每一行 module 都是 http——按模块过滤彻底失效，而"哪个模块在报错"正是最常用的一类查询。
        //      理由：上下文是"这一跳属于哪个传输层"，child 是"这段代码属于哪个业务模块"，
        //      后者更贴近写这行日志的人的意图，所以后者赢。
        // @limitation 这条例外让优先级规则从"一层压一层"变成"一层压一层 + 一个特例"。
        //             若将来还要加第二个特例，说明模型错了，应改成按键分层的显式 merge 表。
        const moduleFromChild = base.module;
        if (typeof moduleFromChild === 'string') payload.module = moduleFromChild;
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
      child: (extra: LogFields) => {
        // N30：child 曾经**不过 splitReserved**——调用点有守卫、child 没有，
        // 无请求上下文处（调度器/启动期）`log.child({ trace_id: 'FORGED' })` 能把伪造身份
        // 烙进每一行日志且无人纠正。现在与调用点同策略：非生产抛错、生产改名留痕，
        // 仅放行 CHILD_BINDABLE_KEYS（module/actor 这两个合法身份通道）。
        const { safe, dropped } = splitReserved(
          capForLog(redact(extra)) as LogFields,
          CHILD_BINDABLE_KEYS,
        );
        if (dropped.length > 0) {
          if (strict) {
            throw new TypeError(
              `logger.child() 不得绑定保留键 ${dropped.join(', ')}：` +
                'child 只能绑定 module / actor（见 CHILD_BINDABLE_KEYS）；' +
                'trace_id 请用 runWithContext()，user_id 由登录态决定。',
            );
          }
          // 生产：与调用点同策略——不炸，但每一行都带上 reserved_dropped 供检索
          safe.reserved_dropped = dropped;
        }
        return make(pinoLogger, { ...base, ...safe });
      },
      raw: pinoLogger,
    };
  };

  return make(p, {});
}
