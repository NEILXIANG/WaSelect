/**
 * 职责：组装根（A1）——**唯一**一处把"配置 / 日志 / 数据库 / HTTP / 路由 / 停机"拼起来的地方。
 *
 * @why 评审 A1 指出：`createHttpApp()` 这个工厂有了，但"谁来组装依赖"只在测试 harness 里
 *      写过一次。后果是**生产没有入口**：没有 `main.ts`、没有 `build`/`start` 脚本，
 *      而且 `packages/shared` 的 `main` 指向 TS 源码，Node 跑不起来。
 *      更隐蔽的代价是"测试与生产两条装配路径"：测试 harness 少配了 `rawBodyPaths` 这种事，
 *      在生产会以另一种方式再错一次。现在两边都走 `bootstrap()`。
 *
 * 设计取舍（我自己拍的，理由写在下面，便于日后被推翻时知道当初为什么）：
 *   1. **不引入打包器**（esbuild/tsup）。全仓库只有一处跨包 import（`@waselect/shared`），
 *      用 `tsc` 双输出 + `exports` 条件导出即可。打包器换来的是"产物不可读、栈追踪错行"，
 *      而栈追踪正是 ADR-29 流 A 排障的主要依据——不划算。
 *   2. **`bootstrap()` 导出、`main()` 只在直接运行时执行**。这样测试能用同一条装配路径
 *      起一个真实服务，不复制一遍依赖拼接。
 *   3. **骨架只在非生产挂载**。骨架能绕过验签改订单状态（SEC2 闸门），
 *      生产环境连挂都不挂——比"挂了再被闸门拦下启动失败"更早一步，也更不容易误判为故障。
 *
 * @limitation 一：摘流量只做**本地标记**（`/readyz` 转 503）。平台是否真的把流量摘走取决于它自己的
 *      健康检查周期——Render 的 drain 窗口内仍可能有新请求进来。彻底解决要靠平台侧的
 *      pre-stop hook，本项目把"本地已经声明不接了"这件事做对就够了：
 *      至少排空不会永远结束不了，且 `/readyz` 的状态可被外部观测。
 * @limitation 二：进程级退出码由 `installShutdownHandlers` 决定，本文件不调用 `process.exit()`
 *      （@see http.ts @limitation 二：立即 exit 会丢最后几条日志）。
 *
 * @see docs/地基搭建清单.md F6 / A1；server/src/http.ts（createHttpApp / installShutdownHandlers）
 */
import { closeDb, createDb, assertPostgresMajor, ping, type Db } from './adapters/db.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, redactConfig, ConfigError, type AppConfig } from './config.js';
import { createHttpApp, installShutdownHandlers, listen, type StartedServer } from './http.js';
import { createLogger, type Logger } from './logger.js';
import { MOCK_CALLBACK_PATH, mountSkeleton } from './skeleton.js';
import { createIdentityCheck, withIdentityCache } from './adapters/identity.js';
import { createWebhookStore } from './adapters/webhooks.js';
import { createIdempotencyExecutor } from './adapters/idempotency.js';
import { createEventBus } from './adapters/event-bus.js';
import { systemClock } from './adapters/clock.js';
import { systemIdGen } from './adapters/ids.js';
import { registerBusinessEventLog } from './app/business-events.js';
import { installProcessErrorHandlers } from './process-errors.js';

/**
 * 是否挂载骨架路由。**生产不挂。**
 *
 * @why 抽成一个函数不是因为它复杂，而是因为它是**一条策略**——策略要能被单独断言。
 *      否则只能"起一个完整生产服务再打请求"来验证，而那需要一整套合法的生产环境变量
 *      （生产闸门还会拒绝指向 localhost 的 DATABASE_URL），测试成本远高于收益。
 * @limitation 这是第二道防线，不是唯一一道：`mountSkeleton()` 自己在 production 下
 *             也会抛错（SEC2）。两道都在，是因为"生产能改订单状态的端点"值得双保险。
 */
export function shouldMountSkeleton(env: AppConfig['NODE_ENV']): boolean {
  return env !== 'production';
}

export interface BootstrapOptions {
  /** 环境变量来源（测试注入用，生产走 process.env）。 */
  env?: NodeJS.ProcessEnv | undefined;
  /** 日志输出目标（测试注入内存流；生产不传，走 stdout）。 */
  logDestination?: Parameters<typeof createLogger>[0]['destination'];
  /** 停机时的退出函数，仅测试注入（@see http.ts ShutdownHooks.exit）。 */
  exit?: ((code: number) => void) | undefined;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  db: Db;
  server: StartedServer;
  /** 卸载信号处理器（生产不调用）。 */
  uninstallSignals: () => void;
  /** 卸载进程级错误处理器（uncaughtException/unhandledRejection；测试必须调，防监听器叠加）。 */
  uninstallProcessErrors: () => void;
}

/**
 * 装配并**启动监听**。测试与生产共用这一条路径。
 *
 * @throws {ConfigError} 配置不合法（启动期硬失败，见 config.ts 抬头）
 * @throws {Error} Postgres 版本不足，或生产环境误挂载骨架
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<Runtime> {
  const config = loadConfig(opts.env ?? process.env);
  // ⚠️ `exactOptionalPropertyTypes` 下不能写 `destination: undefined`——
  //    必须条件展开，否则"不传"和"传 undefined"被当成两回事（pino 会把后者当显式空目标）。
  const logger = createLogger({
    env: config.NODE_ENV,
    ...(opts.logDestination !== undefined ? { destination: opts.logDestination } : {}),
  });

  // ⚠️ 配置要在**用之前**打印一次（脱敏后）："少配了某个变量"在日志里长得和
  //    "用户自己放弃支付"一模一样，启动时打一行是最便宜的自证。
  // ⚠️ 刻意**嵌套在 `config` 键里**而不是展开：直接展开会让配置字段与 logger 的
  //    固定字段（service / env）抢键名——实测 `env` 就被 NODE_ENV 盖了一次。
  //    平铺还会让"这条日志到底属于哪个维度"在检索端无法区分。
  logger.info('config_loaded', { config: redactConfig(config), result: 'ok' });

  const db = createDb({ url: config.DATABASE_URL });
  try {
    const major = await assertPostgresMajor(db);
    logger.info('postgres_checked', { major, result: 'ok' });

    /**
     * 是否还对外宣称"可以接流量"。停机时先置 false，`/readyz` 随即返回 503。
     * @why 用一个闭包变量而不是全局：状态属于**这一次装配**，测试里可以起多个 Runtime 互不干扰。
     */
    let acceptingTraffic = true;

    const app = createHttpApp({
      logger,
      // 回调验签必须用原始字节：路径集中登记在这里，避免"某个回调忘了配就永远验签失败"
      rawBodyPaths: [MOCK_CALLBACK_PATH],
      silentPaths: ['/healthz', '/readyz'],
      // D23：层数来自配置，绝不能写死 true（客户端可伪造 X-Forwarded-For）
      trustProxyHops: config.TRUST_PROXY_HOPS,
      // D21：跨域只对管理端开放；没配 CORS_ORIGINS 就完全不开放（比"全部放行"安全）
      ...(config.CORS_ORIGINS.length > 0
        ? { cors: { origins: config.CORS_ORIGINS, pathPrefixes: ['/api/v1/admin'] } }
        : {}),
      // D21：就绪 = "我自己还想接" 且 "数据库连通"。缺任一条都不该收新流量
      readiness: async () => acceptingTraffic && (await ping(db)),
      mount: (a) => {
        if (!shouldMountSkeleton(config.NODE_ENV)) return; // 骨架不进生产（SEC2，见文件头取舍 3）
        // 事件总线在装配处建、订阅者在装配处注册：业务侧只见"发布"，不见"谁在听"
        const events = createEventBus(logger);
        registerBusinessEventLog(events, logger);
        mountSkeleton(a, {
          db,
          // 回调事件存储：**在这里**把实现装进端口（F10）。业务侧只见接口，不见 SQL。
          webhooks: createWebhookStore(db),
          // 幂等执行器同理：建单走单事务模式，handler 里写业务 SQL 用的就是这个事务。
          idempotency: createIdempotencyExecutor(db),
          events,
          // 时钟：生产装配注入真实时钟；业务侧只见 Clock 接口（F10）
          clock: systemClock,
          // 标识符：同上，业务侧只见 IdGen 接口
          idGen: systemIdGen,
          logger,
          auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
          // ⚠️ mock 回调密钥**独立**于 JWT_SECRET（P1-4）：曾经直接复用 JWT_SECRET，
          //    意味着①回调密钥与登录密钥泄露半径相同②JWT 轮换当天所有模拟回调失效。
          //    生产启用 mock 只可能是审核模式，而跨字段规则已强制那时必须显式配置
          //    MOCK_CALLBACK_SECRET——所以这里的回落值只在开发/测试到达。
          callbackSecret:
            config.MOCK_CALLBACK_SECRET ?? 'dev-mock-callback-secret-do-not-use-in-prod',
          // AJ-32：回调早到宽限期（配置驱动，校准不发版）
          callbackOrderGraceMs: config.CALLBACK_ORDER_GRACE_MS,
          env: config.NODE_ENV,
          // D25：带上身份状态查询，改密 / 封禁后才能真的把旧 token 挡在门外
          identity: withIdentityCache(createIdentityCheck(db)),
        });
      },
    });

    const server = await listen(app, { port: config.PORT, host: config.HOST });

    const shutdown = installShutdownHandlers(server, {
      logger,
      // 摘流量（D1 的第一段）：先让 /readyz 转 503，再等存量请求排空。
      // 顺序反过来就是"发布窗口内一批 500"——@see http.ts ShutdownHooks.beforeDrain 的 @why
      beforeDrain: async () => {
        acceptingTraffic = false;
        logger.warn('traffic_draining', { result: 'ok', ctx: { port: config.PORT } });
      },
      // N7：摘流量后等平台健康检查发现 503 再 close（时长配置驱动，校准不发版）
      readyDelayMs: config.SHUTDOWN_READY_DELAY_MS,
      // 关资源必须在排空之后（D1）：放在前面会让存量请求拿到"连接池已关闭"
      afterDrain: async () => {
        await closeDb(db);
      },
      ...(opts.exit !== undefined ? { exit: opts.exit } : {}),
    });

    // N25：进程级错误的最后一道网——结构化 fatal（可检索）+ 同一停机流 + 退出码 1。
    // 装在停机流**之后**：beginShutdown 需要 trigger；装配期失败不在此覆盖（见 process-errors.ts @limitation 二）
    const uninstallProcessErrors = installProcessErrorHandlers({
      logger,
      beginShutdown: (signal, code) => shutdown.trigger(signal, code),
    });

    // ⚠️ 刻意**不传 env**：`env` 是 logger 的基础字段（每行都有），调用点传它会被保留键规则拒绝，
    //    而放行则会让"这条日志的 env"与"logger 的 env"抢同一个键——后者是启动期决定的，前者是运行期值，
    //    两者一旦不一致，按 env 过滤日志就会得到互相矛盾的结果。
    logger.info('server_started', {
      port: config.PORT,
      host: config.HOST,
      result: 'ok',
    });

    return {
      config,
      logger,
      db,
      server,
      uninstallSignals: shutdown.uninstall,
      uninstallProcessErrors,
    };
  } catch (e) {
    // 装配半途失败时必须关掉连接池：否则进程会挂住，表现为"启动失败但端口还占着"
    await closeDb(db).catch(() => undefined);
    throw e;
  }
}

/**
 * N21：判断 `argv[1]` 是否就是本模块——比**真实路径**，不比文件名后缀。
 *
 * @why 旧实现 `entry.endsWith('/main.js')` 是假阳性制造机：任何叫 main.js 的脚本被直接执行、
 *      且间接 import 了本模块时，都会误触 bootstrap() 自启服务（工具脚本突然开始监听端口）。
 *      `new URL().pathname` 另一头也不可靠：不解码转义字符、Windows 盘符下直接错。
 * @why 双边都过 realpathSync：npm link / bin 软链场景 argv[1] 是软链；
 *      macOS 的 tmpdir 本身也是软链（/var → /private/var），只解一边会比不过。
 * @limitation realpathSync 失败（路径不存在/不可读）一律按"不是入口"处理——
 *             宁可不启动，也不能在判不准的时候自启。
 */
export function isSelfEntry(self: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

/** 是否作为进程入口直接运行（ESM 下没有 require.main，只能比 argv[1]）。 */
function isEntryPoint(): boolean {
  return isSelfEntry(fileURLToPath(import.meta.url), process.argv[1]);
}

/**
 * 把启动失败格式化成 stderr 行（N10）。抽成纯函数：不启进程即可断言输出形状。
 *
 * @why ConfigError 必须**逐行列出全部 issues**：只打 message 的话运维只能改一个变量、
 *      重启、再改一个——配置层"一次列全"的设计就白费了（config.ts ConfigError 的 @why）。
 * @limitation 安全性依赖 issues 本身不含原始值（zod v4 默认消息不带 received 值，
 *             且有 config.unit.test.ts 的 N10 守卫锁死）；本函数不再做二次过滤。
 */
export function formatStartupError(e: unknown): string[] {
  const head = `启动失败：${e instanceof Error ? e.message : String(e)}`;
  if (e instanceof ConfigError) {
    return [head, ...e.issues.map((issue) => `  - ${issue}`)];
  }
  return [head];
}

async function main(): Promise<void> {
  await bootstrap();
}

if (isEntryPoint()) {
  main().catch((e: unknown) => {
    // 启动失败必须能被人看见：这里还没有 logger（可能在 loadConfig 就炸了），只能写 stderr
    for (const line of formatStartupError(e)) process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  });
}
