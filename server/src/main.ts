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
 *   3. **骨架端点已退役**（I1-U6c）：业务路由全部落地后，`/api/v1/skeleton/*`
 *      连同"生产不挂骨架"的闸门（SEC2）一起删除——脚手架的使命是让业务路由
 *      有东西可抄，而不是永远留在装配里多守一道门。
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
import { PAY_CALLBACK_PREFIX } from './app/pay-routes.js';
import { createEventBus } from './adapters/event-bus.js';
import { resolveStorage } from './adapters/storage.js';
import { systemClock } from './adapters/clock.js';
import { registerBusinessEventLog } from './app/business-events.js';
import { drainEventsThenClose } from './app/shutdown-cleanup.js';
import { createCleanupIdempotencyJob } from './app/cleanup-idempotency.js';
import { createDailyHeartbeatWatchJob } from './app/daily-heartbeat-watch.js';
import { createExpireOrdersJob } from './app/expire-orders.js';
import {
  createSchedulerDeps,
  startScheduler,
  type SchedulerHandle,
} from './app/scheduler-start.js';
import { installProcessErrorHandlers } from './process-errors.js';
import { mountAllRoutes } from './app/mount.js';
import { ensureInitialAdmin } from './adapters/admin-auth.js';
import { hashPassword } from './app/auth.js';

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
  /**
   * 常驻调度器把手。
   * @why 必须暴露：`tickNow()` 让集成测试不用等一个 tick 间隔就能验"job 真的跑了"；
   *      `stop()` 让测试能收掉定时器（它 `unref()` 了，但显式停更清楚）。
   */
  scheduler: SchedulerHandle;
  /** 卸载信号处理器（生产不调用）。 */
  uninstallSignals: () => void;
  /** 卸载进程级错误处理器（uncaughtException/unhandledRejection；测试必须调，防监听器叠加）。 */
  uninstallProcessErrors: () => void;
}

/**
 * 装配并**启动监听**。测试与生产共用这一条路径。
 *
 * @throws {ConfigError} 配置不合法（启动期硬失败，见 config.ts 抬头）
 * @throws {Error} Postgres 版本不足
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

    // 初始管理员 seed（D-38 ⑤ / O-11 / AJ-181，B17 / AJ-209）：配齐才跑、幂等、不改已有账号；
    // 日志不带邮箱与口令（约束七）
    if (config.ADMIN_EMAIL !== undefined && config.ADMIN_INITIAL_PASSWORD !== undefined) {
      const seeded = await ensureInitialAdmin(
        db,
        config.ADMIN_EMAIL,
        await hashPassword(config.ADMIN_INITIAL_PASSWORD),
      );
      logger.info('admin_seed', { result: seeded });
    } else if (config.ADMIN_EMAIL !== undefined) {
      /**
       * 只配了邮箱（口令已从平台删掉——AJ-181 承诺的"建号后可删"，B17 之前会被拒绝启动）。
       * @why 必须出声：这是"服务起起来了但没人建管理员"与"管理员已存在"无法从配置上区分的时刻。
       *      静默的后果是"某天部署后谁也登不进管理端"，而日志里什么都没有（B11 那类失效）。
       *      用 warn 而不是 error：已建号的正常终态本来就不该是 error。
       */
      logger.warn('admin_seed_skipped', {
        result: 'skipped',
        ctx: { reason: 'missing_initial_password' },
      });
    }

    /**
     * PAY3-01：生产环境**没有开源站校验**时必须出声。
     *
     * @why 管理端登录的最后一道防线被写成"部署时放到 Cloudflare Access 之后，外部根本碰不到这个接口"
     *      （D-81③ / 清单 ⑦-0）。但 Access 只拦**经过 CF** 的流量：源站 `*.onrender.com`
     *      是公网可达的，`ORIGIN_VERIFY_SECRET` 未配时 http.ts 的源站闸门不生效，
     *      直连源站就绕过了 Access——包括绕过它保护的 `/api/v1/auth/admin/login`。
     *      于是"外部碰不到"这个前提**取决于一个没被任何东西校验的配置**。
     * @why 用 **error 级启动告警**而不是把它做成 `crossField` 的拒启规则：
     *      config.ts 的口径是"只拦确定错误的组合"，而"还没配源站校验"在 A2（拓扑未实测）
     *      之前是一个**合法的中间态**——拒启等于在 staging 实测完成前宣布生产永远起不来。
     *      但它又绝不能静默：静默的后果是"所有人都以为 Access 在保护我们"，而它其实没生效。
     *      ⚠️ 待 A2 实测出拓扑（是否经 CF、`TRUST_PROXY_HOPS` 定几）之后，
     *         这一条应升级为 `crossField` 的**硬规则**（生产 + 声称在代理之后 ⇒ 必须配）。
     */
    if (config.NODE_ENV === 'production' && config.ORIGIN_VERIFY_SECRET === undefined) {
      logger.error('origin_verify_disabled', {
        result: 'unprotected',
        ctx: {
          reason: 'ORIGIN_VERIFY_SECRET 未配置',
          consequence:
            '源站可被直连，Cloudflare Access 与 TRUST_PROXY_HOPS 的假设都不成立；' +
            '管理端登录口（/api/v1/auth/admin/login）对公网开放，仅剩额度与锁定两道防线',
          fix: '配 ORIGIN_VERIFY_SECRET（≥32 字符）+ Cloudflare Transform Rule 注入同值请求头；A2 拓扑实测后改拒启',
        },
      });
    }

    /**
     * 是否还对外宣称"可以接流量"。停机时先置 false，`/readyz` 随即返回 503。
     * @why 用一个闭包变量而不是全局：状态属于**这一次装配**，测试里可以起多个 Runtime 互不干扰。
     */
    let acceptingTraffic = true;

    // 事件总线在装配处建、订阅者在装配处注册：业务侧只见"发布"，不见"谁在听"。
    // ⚠️ 建在 `mount` 之外：常驻调度器也要用同一条总线（它在 `listen` 之后才启动），
    //    两处各建一条的话，"回调发的事件"与"job 发的事件"会落进两个世界，
    //    而订阅者只在其中一个世界里——那正是"能力存在 ≠ 能力被用上"的形态（决策记录 §2 第 35 条）。
    const events = createEventBus(logger);
    const storage = resolveStorage(config);
    registerBusinessEventLog(events, logger);

    const app = createHttpApp({
      logger,
      // 回调验签必须用原始字节：路径集中登记在这里，避免"某个回调忘了配就永远验签失败"
      // ⚠️ 用**前缀**而不是逐个通道列举：新通道自动生效（@see app/pay-routes.ts PAY_CALLBACK_PREFIX）
      rawBodyPaths: [PAY_CALLBACK_PREFIX],
      silentPaths: ['/healthz', '/readyz'],
      // D23：层数来自配置，绝不能写死 true（客户端可伪造 X-Forwarded-For）
      trustProxyHops: config.TRUST_PROXY_HOPS,
      // A2 / AJ-197：源站只接受经 Cloudflare 的流量。**配了才生效**，空 = 不启用这道闸门。
      // ⚠️ 它与 TRUST_PROXY_HOPS 是**成对**的：只有源站不再能被直连，
      //    把层数往大调（拿到真客户端 IP）才不会变成"XFF 可伪造"（config.ts 的 @why）
      originVerifySecret: config.ORIGIN_VERIFY_SECRET,
      // D21：跨域只对管理端开放；没配 CORS_ORIGINS 就完全不开放（比"全部放行"安全）
      // ⚠️ 两个前缀都要给：/admin 是业务路由，/auth/admin 是登录——漏了登录，管理端第一步就死
      ...(config.CORS_ORIGINS.length > 0
        ? {
            cors: {
              origins: config.CORS_ORIGINS,
              pathPrefixes: ['/api/v1/admin', '/api/v1/auth/admin'],
            },
          }
        : {}),
      // D21：就绪 = "我自己还想接" 且 "数据库连通"。缺任一条都不该收新流量
      readiness: async () => acceptingTraffic && (await ping(db)),
      // ⚠️ 路由挂载清单只有一份（app/mount.ts，I1-U1）：路由快照测试也走它，
      //    新增路由只改那一处——绝不要在这里再内联挂路由
      mount: (a) => mountAllRoutes(a, { config, logger, db, events, storage }),
    });

    const server = await listen(app, { port: config.PORT, host: config.HOST });

    /**
     * ── 常驻调度器（D-43）：进程内 `setInterval` + advisory lock ──────────────
     * @why 不做 Render Cron Job：那是另一个进程，拿不到本进程的连接池与健康状态，
     *      且按绝对时钟触发、不关心上一轮跑完没有。代价是"进程挂了调度就停"——
     *      而这正好被 `job_runs` 心跳覆盖：心跳停了 = 该告警（两件事互相补位）。
     * @why 放在 `listen` **之后**：先能收流量再开始跑后台任务，
     *      否则启动期慢的时候会出现"任务在跑、服务还没起来"这种不好归因的中间态。
     */
    /**
     * 进程启动时刻（B11 / AJ-196）：daily 看门狗要用它区分"新部署还没到第一次 daily"
     * 与"起来很久了一次都没跑"。
     * @why 在这里取一次而不是让 job 自己调 `now()`：job 第一次跑的时刻 ≠ 进程启动时刻，
     *      用前者会把启动到首轮之间的空窗算成 0，宽限期判断随即失真（F10：时间只从外面进来）。
     */
    const processStartedAt = systemClock.now();
    const scheduler = startScheduler({
      deps: createSchedulerDeps(db, events, systemClock, logger, { name: 'tick', lockKey: 'tick' }),
      // ⚠️ 顺序即语义（scheduler.ts @limitation 一）：关单永远最先——
      //    其它 job 对同一张单的判断都建立在"它是否还活着"之上
      jobs: [
        createExpireOrdersJob(),
        createCleanupIdempotencyJob(),
        // B11：daily 停跑的看门狗。只读一行、只打日志，放在最后不抢前面 job 的时间
        createDailyHeartbeatWatchJob({ processStartedAt }),
      ],
      intervalMs: config.SCHEDULER_TICK_MS,
    });

    const shutdown = installShutdownHandlers(server, {
      logger,
      // 摘流量（D1 的第一段）：先让 /readyz 转 503，再等存量请求排空。
      // 顺序反过来就是"发布窗口内一批 500"——@see http.ts ShutdownHooks.beforeDrain 的 @why
      beforeDrain: async () => {
        // ⚠️ 先停定时器再摘流量：否则排空的那几秒里可能又开一轮，
        //    而那一轮拿到的锁会一直挂到停机之后（advisory lock 虽随连接释放，但顺序不该靠运气）
        scheduler.stop();
        acceptingTraffic = false;
        logger.warn('traffic_draining', { result: 'ok', ctx: { port: config.PORT } });
      },
      // N7：摘流量后等平台健康检查发现 503 再 close（时长配置驱动，校准不发版）
      readyDelayMs: config.SHUTDOWN_READY_DELAY_MS,
      // 关资源必须在排空之后（D1）：放在前面会让存量请求拿到"连接池已关闭"
      afterDrain: async () => {
        // B13 / AJ-202：ⓐ **先**等异步领域事件订阅者跑完，ⓑ 再关连接池。
        //    直接关库的话，`order.cancelled` 之后作废机构会话的那个订阅者会拿到
        //    "连接池已关闭" ⇒ 已取消/已过期的单在会话自然过期前（最长约 30 分钟）
        //    还能被付款。等的时间由 SHUTDOWN_EVENT_DRAIN_MS 封顶，到点照常关库并记 error。
        await drainEventsThenClose({
          events,
          db,
          logger,
          drainMs: config.SHUTDOWN_EVENT_DRAIN_MS,
          // ⚠️ 关库也要有上限（INF3-01）：`db.end()` 会等在途事务跑完，
          //    而"排空失败"这条分支里最可能卡住的就是持事务的那次出站调用。
          //    取 5s：比出站总预算 6s 略短，是"给常规善终留的机会"，剩下的交给总预算兜底。
          closeTimeoutMs: 5_000,
        });
      },
      // INF3-01：总预算从收到信号那一刻起算，到点 exit(1)（不再等任何一步）
      totalBudgetMs: config.SHUTDOWN_TOTAL_BUDGET_MS,
      budgetFlushMs: config.SHUTDOWN_BUDGET_FLUSH_MS,
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
      // 暴露调度器把手：测试要能"立刻跑一轮"而不等 60 秒，也要能显式停掉定时器（否则进程不退出）
      scheduler,
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
