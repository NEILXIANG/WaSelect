/**
 * 职责：**路由装配的唯一清单**（I1-U1 从 main.ts 抽出）——把"哪些路由挂在应用上"
 *       收敛成一个可被生产与测试**共同调用**的函数。
 *
 * @why 抽出前，路由挂载内联在 `bootstrap()` 的 `mount:` 回调里：路由快照测试
 *      （routes.contract.test.ts）想拿到"代码真实挂了哪些路由"只有两条路——
 *      复制一份挂载代码（必漂移），或者起整个 bootstrap（要真 DB、真端口）。
 *      两条都不可接受。收敛成一个函数后：**生产走它、快照测试也走它**，
 *      新增路由只改这一处，比对器看到的必然与生产一致。
 *      这正是"能力存在 ≠ 能力被用上"的防线：挂载清单只有一份，不存在"忘了挂"。
 *
 * @why 入参是**已构造**的依赖袋（MountContext）而不是 env/config 原样：
 *      本函数只做"路由 ← 依赖"的装配，不做"依赖 ← 环境"的构造（那是 bootstrap 的事）。
 *      快照测试正是利用这一点：传入不触库的 stub 依赖，挂载期不执行任何 IO。
 *
 * @limitation 一：挂载期**不触库、不出站**。webhook store / idempotency / identity 这些
 *              工厂都只是闭包捕获 db 句柄，不执行查询；快照测试依赖这一性质——
 *              将来若有人在某个工厂构造期加了 IO，快照测试会立刻变红（stub db 被调用即抛），
 *              这是刻意的自证。
 * @limitation 二：`payment_channels_registered` 的启动日志留在这里（而不是 main.ts）：
 *              它与挂载是同一件事（"配置了哪些 / 注册了哪些 / 下线了哪些"必须在挂载时打），
 *              拆开会让"通道清单日志"与"实际挂载"失去同时性。
 *
 * @see main.ts（调用方，生产装配）；routes.contract.test.ts（调用方，路由快照）；
 *      docs/I1阶段开发实施方案.md §3.1
 */
import type { Express } from 'express';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Db } from '../adapters/db.js';
import type { EventBus } from '../ports/events.js';
import { createFetchClient } from '../adapters/http/fetch-client.js';
import { buildPaymentRegistry, describeChannels } from '../adapters/payment/channels.js';
import { createWebhookStore } from '../adapters/webhooks.js';
import { createIdempotencyExecutor } from '../adapters/idempotency.js';
import { createIdentityCheck, withIdentityCache } from '../adapters/identity.js';
import { systemClock } from '../adapters/clock.js';
import { systemIdGen } from '../adapters/ids.js';
import { mountSkeleton } from '../skeleton.js';
import { outboundHttpOptions } from './http-outbound.js';
import { mountPayRoutes } from './pay-routes.js';
import { markOrderPaid } from './mark-paid.js';
import { createMemoryRateLimitStore } from '../adapters/rate-limit-memory.js';
import { rateLimiter, rateLimitRules } from './rate-limit.js';
import { mountQuoteRoutes } from './quote-routes.js';
import { mountProductRoutes } from './product-routes.js';
import { mountAddressRoutes } from './address-routes.js';
import { mountOrderRoutes } from './order-routes.js';
import { mountOrderQueryRoutes } from './order-query-routes.js';

/**
 * 是否挂载骨架路由。**生产不挂。**
 *
 * @why 抽成一个函数不是因为它复杂，而是因为它是**一条策略**——策略要能被单独断言。
 *      否则只能"起一个完整生产服务再打请求"来验证，而那需要一整套合法的生产环境变量
 *      （生产闸门还会拒绝指向 localhost 的 DATABASE_URL），测试成本远高于收益。
 * @limitation 这是第二道防线，不是唯一一道：`mountSkeleton()` 自己在 production 下
 *             也会抛错（SEC2）。两道都在，是因为"生产能改订单状态的端点"值得双保险。
 *             ⚠️ 本函数从 main.ts 迁来（I1-U1），main.ts 有 re-export，外部 import 路径不变。
 */
export function shouldMountSkeleton(env: AppConfig['NODE_ENV']): boolean {
  return env !== 'production';
}

/** 路由装配所需的已构造依赖（构造归 bootstrap，装配归本模块）。 */
export interface MountContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  events: EventBus;
}

/**
 * 把全部业务路由挂到应用上。**生产与路由快照测试共用这一条路径**（见文件头 @why）。
 */
export function mountAllRoutes(app: Express, ctx: MountContext): void {
  const { config, logger, db, events } = ctx;

  // ── 支付路由（F11）：**每个环境都挂**，它不是脚手架 ──────────────────────
  // @why 回调是机构打给我们的，生产必须能收；通道列表是前端入口的来源。
  //      它们与骨架无关——骨架只是"没有真实下单接口时的一条演示链路"。
  //      注册表在装配处按配置拼好：加一个通道 = 改配置 + 注册工厂，本处不改。
  const {
    registry,
    registered: registeredChannels,
    offline: offlineChannels,
  } = buildPaymentRegistry(config, {
    // ⚠️ `logger` **必须传**：不传的话出站 HTTP 一条日志都没有
    //    ——计时、重试、以及"我们正在拒绝请求"的熔断信号全部丢失，
    //    而它们正是线上回答"上游是不是挂了"的唯一依据（AJ-55 / AJ-62 / AJ-63）。
    //    熔断**默认开启**：忘了配的后果是"静默地没有保护"，所以默认造一个。
    // ⚠️ 三个数字（单次超时 / 总预算 / 熔断策略）**来自配置**而不是实现层的兜底常量：
    //    它们是运营参数（用户能等多久、上游故障形态），上线后必然要调，
    //    调整不该发版。@see ./http-outbound.ts
    http: createFetchClient({ logger, ...outboundHttpOptions(config) }),
    clock: systemClock,
    idGen: systemIdGen,
  });
  // ⚠️ configured / registered / offline 三个清单必须并列：
  //    configured−registered = 被静默跳过的通道（wechat 未实现 / stripe 密钥不全），
  //    offline = 已下线但在途订单还活着的通道（二次审查 P1-NEW-1）——只打 configured 等于没打
  logger.info('payment_channels_registered', {
    result: 'ok',
    ctx: {
      configured: describeChannels(config),
      registered: registeredChannels,
      offline: offlineChannels,
    },
  });
  mountPayRoutes(app, {
    registry,
    webhooks: createWebhookStore(db),
    logger,
    graceMs: config.CALLBACK_ORDER_GRACE_MS,
    // 骨架期只有"把订单置为 paid"这一件事；业务期（I1）换成订单状态机的迁移。
    // ⚠️ 第二、三、四个参数必须来自回调本身（通道 / 机构单号 / 金额币种）：
    //    落账逐项核对它们与 `payments` 行（三审 S1② / U1），对不上就不落账
    apply: async (e, channel) =>
      markOrderPaid(db, events, systemClock, e.orderId, {
        kind: 'provider',
        channel,
        providerRef: e.providerRef,
        amountMinor: e.amountMinor,
        currency: e.currency,
      }),
  });

  // ── 报价路由（I1-U4）：**每个环境都挂**，与支付路由同理——它是产品接口不是脚手架 ──
  /**
   * 限流（I1-U3）：store 建在挂载处（进程级）——计数必须跨请求存活；
   * 建在中间件里就成"每请求清零"。规则表（rate-limit.ts）是唯一出处。
   * ⚠️ store 必须在骨架闸门**之前**建：报价/支付路由全环境挂载，限流不能只在非生产存在。
   * ⚠️ 进程内实现只在**单实例**下正确（rate-limit-memory.ts @limitation 一，R-I1-2）。
   */
  const rateLimitStore = createMemoryRateLimitStore();
  const rateLimitDeps = { store: rateLimitStore, clock: systemClock, logger };
  app.use('/api/v1/orders/quote', rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite));
  mountQuoteRoutes(app, {
    db,
    logger,
    clock: systemClock,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity: withIdentityCache(createIdentityCheck(db)),
    config,
  });

  // ── 商品/配置公开端点 + 我的地址（I1-U5a）：全环境挂载（产品接口不是脚手架）──
  mountProductRoutes(app, { db, clock: systemClock, config });
  mountAddressRoutes(app, {
    db,
    logger,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity: withIdentityCache(createIdentityCheck(db)),
    idGen: systemIdGen,
  });

  // ── 建单（I1-U5b）：幂等 + 限流只挂 POST（GET /orders 系只读不共用写配额，order-routes @why）
  mountOrderRoutes(app, {
    db,
    logger,
    clock: systemClock,
    idGen: systemIdGen,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity: withIdentityCache(createIdentityCheck(db)),
    idempotency: createIdempotencyExecutor(db),
    events,
    createOrderLimiter: rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite),
  });

  // ── 订单读路径（I1-U5c）：只读不共用写配额（order-query-routes @why）──
  mountOrderQueryRoutes(app, {
    db,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity: withIdentityCache(createIdentityCheck(db)),
  });

  if (!shouldMountSkeleton(config.NODE_ENV)) return; // 骨架不进生产（SEC2，见 @limitation）
  app.use('/api/v1/skeleton', rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite));
  mountSkeleton(app, {
    db,
    // 幂等执行器：建单走单事务模式，handler 里写业务 SQL 用的就是这个事务。
    idempotency: createIdempotencyExecutor(db),
    events,
    // 时钟：生产装配注入真实时钟；业务侧只见 Clock 接口（F10）
    clock: systemClock,
    // 标识符：同上，业务侧只见 IdGen 接口
    idGen: systemIdGen,
    logger,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    env: config.NODE_ENV,
    // D25：带上身份状态查询，改密 / 封禁后才能真的把旧 token 挡在门外
    identity: withIdentityCache(createIdentityCheck(db)),
  });
}
