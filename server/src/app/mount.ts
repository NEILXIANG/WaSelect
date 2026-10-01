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
import type { ObjectStorage } from '../ports/storage.js';
import { createFetchClient } from '../adapters/http/fetch-client.js';
import { buildPaymentRegistry, describeChannels } from '../adapters/payment/channels.js';
import { createWebhookStore } from '../adapters/webhooks.js';
import { createIdempotencyExecutor } from '../adapters/idempotency.js';
import { createIdentityCheck, withIdentityCache } from '../adapters/identity.js';
import { systemClock } from '../adapters/clock.js';
import type { Clock } from '../ports/clock.js';
import { systemIdGen } from '../adapters/ids.js';
import { outboundHttpOptions } from './http-outbound.js';
import { mountPayRoutes } from './pay-routes.js';
import type { CallbackPipelineDeps } from './pay-callback.js';
import { createAutoConfirm } from './auto-confirm.js';
import { mountAdminAuthRoutes } from './admin-auth-routes.js';
import { adminAuditMiddleware } from './admin-audit.js';
import { createAdminAuditStore } from '../adapters/admin-audit.js';
import { AppError } from '../errors.js';
import { markOrderPaid } from './mark-paid.js';
import { markDisputeClosed, markOrderDisputed } from './mark-disputed.js';
import { parseDisputeResult } from '../domain/dispute-input.js';
import { RESULT_DISPUTED, RESULT_DISPUTE_CLOSED, RESULT_PAID } from './webhook-results.js';
import { createMemoryRateLimitStore } from '../adapters/rate-limit-memory.js';
import { rateLimiter, rateLimitRules } from './rate-limit.js';
import { mountQuoteRoutes } from './quote-routes.js';
import { mountProductRoutes } from './product-routes.js';
import { mountAdminProductRoutes } from './admin-product-routes.js';
import { mountAdminOrderRoutes } from './admin-order-routes.js';
import { mountAdminOpsRoutes } from './admin-ops-routes.js';
import { mountAdminBannerRoutes } from './admin-banner-routes.js';
import { mountAdminRiskRoutes } from './admin-risk-routes.js';
import { mountAdminUploadRoutes } from './admin-upload-routes.js';
import { mountAddressRoutes } from './address-routes.js';
import { mountOrderRoutes } from './order-routes.js';
import { mountOrderQueryRoutes } from './order-query-routes.js';
import { mountPayIntentRoutes } from './pay-intent-routes.js';
import { mountPayLinkRoutes } from './pay-link-routes.js';
import { registerSessionExpiryOnClose } from './close-session-events.js';
import { mountWechatAuthRoutes } from './wechat-auth-routes.js';
import { mountInternalJobsRoutes } from './internal-jobs-routes.js';
import { createInflightJobs, type InflightJobs } from './inflight-jobs.js';
import { createWechatAuth } from '../adapters/wechat/code2session.js';
import { createDevWechatAuth } from '../adapters/wechat/dev-auth.js';

/** 路由装配所需的已构造依赖（构造归 bootstrap，装配归本模块）。 */
export interface MountContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  events: EventBus;
  /** 对象存储驱动（构造归 `adapters/storage.ts` 的 resolveStorage）；null = 生产未配置，上传路由 50000 响亮拒绝。 */
  storage: ObjectStorage | null;
  /**
   * 在途后台作业的登记表（OPS3-05）：`POST /internal/jobs/daily` 的作业句柄登记在这里，
   * **停机流要等它**（main.ts `afterDrain`）。
   *
   * @why 放在上下文里由调用方传入，而不是本函数自建：
   *      "谁在等这些作业"必须是**看得见的装配关系**——自建的话，main.ts 拿不到同一个实例，
   *      停机流等的是一个永远为空的表（看起来在等，实际什么也没等）。
   * @limitation 不传时本函数会自建一个（**只适用于测试**）：那时没有停机流，
   *      等不等都无所谓；但生产（main.ts）必须传——由 `main.db.test.ts`
   *      「daily 作业登记进 bootstrap 暴露的登记表」盯住这条接线（它从 `bootstrap()`
   *      的返回值取表，再用真 HTTP 触发 daily，证明两边是同一个实例）。
   */
  inflightJobs?: InflightJobs | undefined;
  /**
   * 时钟。**生产不传**（= `systemClock`）；测试可传固定时钟，让"时间相关"的接线可断言。
   *
   * @why 装配层曾经在 11 处**硬编码** `systemClock`（限流 / 支付注册 / 各组路由各一份）。
   *      于是任何依赖"现在几点"的接线行为在测试里都不可控——真实形态是
   *      `pay-intent-routes.db.test.ts` 那条限流用例：限流是**时钟对齐**的固定窗口
   *      （`windowStartOf` = `floor(now/60000)×60000`），31 次请求一旦跨过整分边界，
   *      计数就被重置，第 31 次拿不到 42901——用例的成败取决于它相对窗口边界的**相位**，
   *      约 0.5% 的概率随机红（2026-10-01 C3 全量重读时实测撞上过一次）。
   *      把时钟收进上下文后，注入一次就把全站时间变成确定量，不留概率。
   * @why 收在**上下文**而不是逐个函数加参数：11 处各自加参数等于 11 次"这次要不要注入"的
   *      判断，漏一处就回到"一半受控、一半随真实时钟漂移"——那比全不注入更难查。
   * @limitation 只覆盖 `mountAllRoutes` 这一层；`main.ts` 里调度器、停机流等
   *              装配期之外的时钟仍走 `systemClock`（它们在 bootstrap 层，不进本函数）。
   */
  clock?: Clock | undefined;
}

/**
 * 把全部业务路由挂到应用上。**生产与路由快照测试共用这一条路径**（见文件头 @why）。
 */
export function mountAllRoutes(app: Express, ctx: MountContext): void {
  const { config, logger, db, events, storage } = ctx;
  // ⚠️ 生产不传 → 与改之前逐字等价（`systemClock`）；测试传 → 全站时间受控（@see MountContext.clock）
  const clock = ctx.clock ?? systemClock;
  // ⚠️ 生产必须传（见 MountContext.inflightJobs 的 @limitation）；不传时自建仅供测试
  const inflightJobs = ctx.inflightJobs ?? createInflightJobs();
  // ── 身份状态回源（D25）：**全站共用一份缓存实例**（KD-6，2026-09-28 测试审查读码确认；AJ-175）。
  //    曾经每组路由各自 `withIdentityCache(createIdentityCheck(db))`，共 11 份独立缓存——
  //    同一个人被封禁/撤权后，各组路由在不同时刻（最长各 60 秒）才生效：买家在订单页已被拒、
  //    在地址页仍放行；token_ver 变更后重登拿到的新 token 也可能被某一组尚未过期的旧缓存拒成 40101。
  //    一份实例 = 全站同一时刻看到同一个身份状态（仍有最长 60 秒的缓存窗口，这是既定口径）。
  const identity = withIdentityCache(createIdentityCheck(db));

  // ── 支付路由（F11）：**每个环境都挂**，它不是脚手架 ──────────────────────
  // @why 回调是机构打给我们的，生产必须能收；通道列表是前端入口的来源。
  //      注册表在装配处按配置拼好：加一个通道 = 改配置 + 注册工厂，本处不改。
  // 出站 HTTP 客户端（支付通道与微信登录共用一份：超时/总预算/熔断/日志的唯一出处）。
  // ⚠️ `logger` **必须传**：不传的话出站 HTTP 一条日志都没有
  //    ——计时、重试、以及"我们正在拒绝请求"的熔断信号全部丢失，
  //    而它们正是线上回答"上游是不是挂了"的唯一依据（AJ-55 / AJ-62 / AJ-63）。
  //    熔断**默认开启**：忘了配的后果是"静默地没有保护"，所以默认造一个。
  // ⚠️ 三个数字（单次超时 / 总预算 / 熔断策略）**来自配置**而不是实现层的兜底常量：
  //    它们是运营参数（用户能等多久、上游故障形态），上线后必然要调，
  //    调整不该发版。@see ./http-outbound.ts
  const outboundHttp = createFetchClient({ logger, ...outboundHttpOptions(config) });
  const {
    registry,
    registered: registeredChannels,
    offline: offlineChannels,
  } = buildPaymentRegistry(config, {
    http: outboundHttp,
    clock,
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
  // 回调管线依赖**只造这一份**：`/pay/callback/{channel}` 与审核模式自动确认（AJ-179）共用——
  // 两份各自装配的后果是"自动确认走的落账器与真实回调不是同一套"，审核期验到的就不是生产那条路
  const callbackPipeline: CallbackPipelineDeps = {
    webhooks: createWebhookStore(db),
    logger,
    graceMs: config.CALLBACK_ORDER_GRACE_MS,
    appliers: {
      // 落账 = 订单状态机的迁移（mark-paid 核对 payments 行后置 paid）。
      // ⚠️ 第二、三、四个参数必须来自回调本身（通道 / 机构单号 / 金额币种）：
      //    落账逐项核对它们与 `payments` 行（三审 S1② / U1），对不上就不落账
      succeeded: {
        apply: async (e, channel) =>
          markOrderPaid(db, events, clock, e.orderId, {
            channel,
            providerRef: e.providerRef,
            amountMinor: e.amountMinor,
            currency: e.currency,
          }),
        result: RESULT_PAID,
        disposition: 'paid',
      },
      /**
       * 拒付落库（U-F3）：**不迁订单状态**，只标 `orders.has_dispute` + 写 `payments.dispute_*`。
       * ⚠️ 开案时刻取**机构报的时间**（`event.occurredAtMs`），不是入库时刻——
       *    它是举证期限的起点，用后者会把举证窗口**算短**（AJ-159 / 迁移 013）。
       *    机构没给时 `markOrderDisputed` 会**拒落库**转对账，这里不降级成"用当前时间"：
       *    "有值但错了"比"没有值"更难发现。
       * @see app/mark-disputed.ts（结案由下面的 dispute_closed 落账器处理，AJ-162 / AJ-176）
       */
      disputed: {
        apply: async (e, channel) =>
          markOrderDisputed(db, events, logger, e.orderId, {
            channel,
            disputeId: e.providerRef,
            amountMinor: e.amountMinor,
            currency: e.currency,
            openedAtMs: e.occurredAtMs,
          }),
        result: RESULT_DISPUTED,
        disposition: 'disputed',
      },
      /**
       * 拒付结案（U-F4）：写 won/lost/withdrawn + 结案时刻，并据此决定 `orders.has_dispute`
       * **是否解除**（lost 不解除，won 与 withdrawn 解除）。
       * @why 解除与否是这条的关键：发货/退款闸门读的就是 `has_dispute`，
       *      语义是"**未解除的拒付限制**"。
       *      结案后该解除却不解除 = 这张单永远不能发货、不能退款，且没有任何一方报错
       *      （这正是 B1 / AJ-193 修掉的现场：查询函以 `warning_closed` 结案时旧实现走到
       *      `dispute_result_unknown`，`has_dispute` 从此永远是 true）。
       * ⚠️ 只有 **lost** 保持 true（钱已被机构拉回，发货 = 钱货两空、退款在机构侧必败）；
       *    won 与 withdrawn 都复位（withdrawn = 机构撤回 / 未进入正式拒付，没有输赢）。
       * ⚠️ 结果由 domain 从机构 status 映射；**认不出就拒绝落库**
       *    （`dispute_result_unknown` → 管线按 error 级处理、转对账），
       *    绝不猜一个默认值——"赢了却记成输了"和"输了却记成赢了"都是财务口径事故。
       */
      dispute_closed: {
        apply: async (e, channel) => {
          const result = parseDisputeResult(e.disputeStatus);
          if (result === undefined) {
            throw new AppError(40902, {
              reason: 'dispute_result_unknown',
              ctx: { got: e.disputeStatus ?? null },
            });
          }
          return markDisputeClosed(db, events, e.orderId, {
            channel,
            disputeId: e.providerRef,
            result,
          });
        },
        result: RESULT_DISPUTE_CLOSED,
        disposition: 'dispute_closed',
      },
    },
  };
  mountPayRoutes(app, { registry, ...callbackPipeline });

  // ── 报价路由（I1-U4）：**每个环境都挂**，与支付路由同理——它是产品接口不是脚手架 ──
  /**
   * 限流（I1-U3）：store 建在挂载处（进程级）——计数必须跨请求存活；
   * 建在中间件里就成"每请求清零"。规则表（rate-limit.ts）是唯一出处。
   * ⚠️ store 在挂载处统一建、所有受限流路由共用同一份：报价/支付等路由全环境挂载，
   *    限流也必须全环境存在（不能只在某个环境才有计数）。
   * ⚠️ 进程内实现只在**单实例**下正确（rate-limit-memory.ts @limitation 一，R-I1-2）。
   */
  const rateLimitStore = createMemoryRateLimitStore();
  const rateLimitDeps = { store: rateLimitStore, clock, logger };
  app.use(
    '/api/v1/orders/quote',
    rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite('orders.quote')),
  );
  mountQuoteRoutes(app, {
    db,
    logger,
    clock,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    config,
  });

  // ── 商品/配置公开端点 + 我的地址（I1-U5a）：全环境挂载（产品接口不是脚手架）──
  mountProductRoutes(app, { db, clock, config, logger });

  // ── 管理端操作审计（流 B / ADR-29；F-02 / AJ-183）：**先于**所有管理端路由挂在 /api/v1/admin 前缀上——
  //    新增的管理端写路由自动被审计（admin-audit.ts @why）；挂在后面的话，前面那些路由就漏了 ──
  // ── ⚠️ `jobs` 必须是本函数顶部那一份（不是新建的）：审计写在响应之后，
  //    停机排空等的是 `ctx.inflightJobs` 这张表（admin-audit.ts 文件头 @why）──
  app.use(
    '/api/v1/admin',
    adminAuditMiddleware({ store: createAdminAuditStore(db), logger, jobs: inflightJobs }),
  );

  // ── 管理端商品（I2-U-A3）：守卫在路由文件内共用一个实例（admin-product-routes @why）；
  //    identity 与其它路由共用同一份缓存实例——管理员也要能被即时撤权 ──
  mountAdminProductRoutes(app, {
    db,
    logger,
    idGen: systemIdGen,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
  });
  // ── 管理端订单（I2-U-B2d）：注册表用本函数顶部装配的那一份——退款要按订单当时的
  //    通道取 provider（老单退款不受"通道已下线"影响，getForRefund 内部判
  //    refundableWhenDisabled），注册表必须是可插拔的唯一出处 ──
  mountAdminOrderRoutes(app, {
    db,
    logger,
    config,
    clock,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    registry,
  });
  // ── 管理端运营配置（I2-U-C3）：展示汇率与运费分档。clock 必须注入——
  //    "立即生效"的 effective_from 取它，否则这条路由无法在假时间下测（F10）──
  mountAdminOpsRoutes(app, {
    db,
    logger,
    config,
    clock,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
  });
  // ── 管理端 Banner（I2-U-D3）：`image` 完整 URL 由本路由用 config.IMG_BASE_URL 拼
  //    （它是该配置项的**第一个**消费方，此前配了但没人用）──
  mountAdminBannerRoutes(app, {
    db,
    logger,
    config,
    idGen: systemIdGen,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
  });
  // ── 管理端风控（I2-U-E3）：拒付列表 + 拉黑。拉黑是本项目第一个**不可逆**的写操作
  //    （契约没有解除接口）：业务日志 + admin_audit（前缀审计中间件，AJ-183）+ 身份缓存即时作废（F-06）──
  mountAdminRiskRoutes(app, {
    db,
    logger,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    // B28 / AJ-213：拉黑连带取消在途单并发 `order.cancelled`（作废机构会话）
    events,
    clock,
  });

  // ── 管理端上传（I2-U-I4）：storage 由依赖袋传入（测试用 memory 驱动断言 put）；
  //    null = 生产未配置，路由照挂、调用时 50000 storage_not_configured（wechat 同款）──
  mountAdminUploadRoutes(app, {
    logger,
    config,
    idGen: systemIdGen,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    storage,
  });

  mountAddressRoutes(app, {
    db,
    logger,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    idGen: systemIdGen,
  });

  // ── 建单（I1-U5b）：幂等 + 限流只挂 POST（GET /orders 系只读不共用写配额，order-routes @why）
  mountOrderRoutes(app, {
    db,
    logger,
    clock,
    idGen: systemIdGen,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    idempotency: createIdempotencyExecutor(db),
    events,
    // MP3-04：取消订单前要问机构"这个会话付了没有"
    registry,
    createOrderLimiter: rateLimiter(
      rateLimitDeps,
      rateLimitRules(config).publicWrite('orders.create'),
    ),
  });

  // ── 订单读路径（I1-U5c）：只读不共用写配额（order-query-routes @why）──
  mountOrderQueryRoutes(app, {
    db,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
  });

  // ── 发起支付（I1-U6a）：幂等 + 限流；注册表用本函数顶部装配的那一份（可插拔唯一出处）──
  mountPayIntentRoutes(app, {
    db,
    logger,
    clock,
    idGen: systemIdGen,
    config,
    auth: { secret: config.JWT_SECRET, issuer: 'waselect' },
    identity,
    idempotency: createIdempotencyExecutor(db),
    registry,
    payLimiter: rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite('orders.pay')),
    // 审核模式自动确认（§2.9 / AJ-179）：是否真的确认由通道能力决定，这里全环境装配
    autoConfirm: createAutoConfirm({ db, registry, logger, pipeline: callbackPipeline }),
  });

  // ── 短链落地（I1-U6a-2 / D-49）：无鉴权（token 即凭证）；限流 publicWrite（独立桶） ──
  mountPayLinkRoutes(app, {
    db,
    clock,
    logger,
    checkoutBaseUrl: config.CHECKOUT_BASE_URL,
    linkLimiter: rateLimiter(rateLimitDeps, rateLimitRules(config).publicWrite('pay.link')),
  });

  // ── 小程序登录（I1-U6b）：真 AppID 优先；dev 替身只在 development/test 注册
  //    （第二道防线——第一道是 loadConfig 规则 1c 拒生产/staging；双保险：
  //    配置层拒了还不够，装配层再拦一次"配置被绕过"的情况）；
  //    两者皆无 → null（路由照挂，调用时 50000 wechat_login_not_configured，见路由 @why）──
  const wechatAuth =
    config.APP_ID !== undefined && config.APP_SECRET !== undefined
      ? createWechatAuth({ http: outboundHttp, appId: config.APP_ID, appSecret: config.APP_SECRET })
      : config.WECHAT_DEV_LOGIN !== undefined &&
          (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')
        ? createDevWechatAuth(config.WECHAT_DEV_LOGIN)
        : null;
  mountWechatAuthRoutes(app, {
    db,
    logger,
    idGen: systemIdGen,
    authConfig: { secret: config.JWT_SECRET, issuer: 'waselect' },
    wechatAuth,
    loginLimiter: rateLimiter(
      rateLimitDeps,
      rateLimitRules(config).publicWrite('auth.wechat.login'),
    ),
  });

  // ── 管理员登录（D-38 ⑤ / O-11 / AJ-181）：IP 限流（adminLogin 规则，D-52）+ 账号锁定（路由内）──
  mountAdminAuthRoutes(app, {
    db,
    logger,
    clock,
    authConfig: { secret: config.JWT_SECRET, issuer: 'waselect' },
    loginLimiter: rateLimiter(rateLimitDeps, rateLimitRules(config).adminLogin),
  });

  // ── 每日作业触发（I1-U7b / D-43）：Render Cron 的 HTTP 入口；异步执行走同一套调度器框架 ──
  mountInternalJobsRoutes(app, { config, logger, db, events, jobs: inflightJobs });

  // ── D-50 关单连带（I1-U6a-2）：order.expired/cancelled → 作废在途支付行 +
  //    best-effort 作废机构会话。注册在这里（不在 main.ts）：registry 是本函数
  //    局部装配的，订阅者与路由共用同一份才是"可插拔唯一出处"的真实兑现 ──
  registerSessionExpiryOnClose(events, { db, logger, registry });
}
