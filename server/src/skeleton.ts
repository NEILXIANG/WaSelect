/**
 * 职责：行走骨架（F6c）——一条贯穿全栈的最小链路：建单 → 模拟支付回调 → 状态回写 → 全程同一 trace_id。
 *
 * 边界：**不含任何业务规则**（无价格计算、无库存、无关税、无状态机）。
 *       它只是把「HTTP → 鉴权 → 事务 → 幂等 → 回调原始报文 → 日志链路」这条管线跑通一遍，
 *       好让后面每个阶段往这条线上加东西，而不是等到最后才第一次接起来。
 *
 * @why 地基阶段的各块（配置/错误/日志/鉴权/DB/幂等）都是分开测的，
 *      分开全绿**推不出**接起来也通：中间件顺序错一格、事务里用了外层连接、
 *      回调路由拿到的是已解析的 body——这三类的共同点是"每一块单独看都对"。
 *      所以必须在阶段二末尾先跑一条细线，把集成问题暴露在只有一个变量的时候。
 *
 * @limitation 一：这是**骨架**，不是业务代码。业务期（I1）真正的下单/支付路由会替换它，
 *              本文件届时整体删除；所以在路由路径上保留 `/skeleton/` 前缀，
 *              让人一眼看出"这是脚手架，不是产品接口"，避免被误当成正式 API 依赖。
 * @limitation 二：回调的"验签"是 HMAC 占位实现（密钥来自调用方传入）。
 *              真实通道的验签在 F11 由各自的 Provider 适配器实现（Stripe 的签名头结构完全不同）；
 *              这里只验证"骨架能从**未被解析的原始字节**验签"这一件事。
 * @limitation 三：跨跳（下单 → 回调）的日志串联**不靠 trace_id**——真实的微信/Stripe 回调
 *              不会带上我们的 trace_id。真实世界的串联靠 `order_id`（落 `order_events`）。
 *              骨架里让调用方**显式回传**同一个 `x-trace-id` 只是为了可测：
 *              端到端测试据此断言"两跳的日志能串成一条链"，同时另有断言按 order_id 查事件。
 *
 * @see docs/地基搭建清单.md F6c；docs/测试策略与验证门禁.md（L3 端到端）
 */
import type { Express } from 'express';
import { paramId } from './http.js';
import { requireRole, type AuthConfig } from './app/auth.js';
import { currentContext } from './context.js';
import type { Db } from './adapters/db.js';
import { buildOrderNo } from './domain/order-no.js';
import type { Clock } from './ports/clock.js';
import type { IdGen } from './ports/ids.js';
import { AppError } from './errors.js';
import { markOrderPaid } from './app/mark-paid.js';
import { scopeKey, type IdempotencyExecutor } from './ports/idempotency.js';
import type { DomainEvent, EventBus } from './ports/events.js';
import type { Logger } from './logger.js';
import type { IdentityCheck } from './adapters/identity.js';

export interface SkeletonDeps {
  db: Db;
  /**
   * 幂等执行器（F10 端口）。**必填**：装配时由 `createIdempotencyExecutor(db)` 注入。
   *
   * @why 同 `webhooks`：可选就一定有人不传，然后悄悄退化回"直接 import 适配器"。
   * @limitation 类型写成 `IdempotencyExecutor<Db>`——事务句柄目前仍是 postgres.js 的 `Db`，
   *             因为建单 handler 必须在这个事务里写业务 SQL（AJ-47）。
   *             这不是"业务认识 SQL"，只是"业务看得见事务句柄这个类型"；
   *             真正的 Db 端口等 domain 出现后按真实用法提炼。
   */
  idempotency: IdempotencyExecutor<Db>;
  /**
   * 领域事件总线（F10 端口）。**必填**：装配时由 `createEventBus(logger)` 注入。
   *
   * @why 同 webhooks / idempotency：可选就一定有人不传。
   *      而且总线**必须带 logger**（订阅者失败要落 error），装配处不传就是"静默吞异常"。
   */
  events: EventBus;
  /**
   * 时钟（F10 端口）。**必填**：装配时注入 `systemClock`（生产）或 `fixedClock`（测试）。
   *
   * @why 同 webhooks / idempotency：可选就一定有人不传，然后悄悄退回 `new Date()`。
   *      而"现在几点"一旦退回全局，所有依赖它的边界（JST 业务日、跨日那一秒、
   *      到期判断）就**只能在真实时间下测**——也就是说这些分支实际上没有测试。
   * @limitation 只管"业务时间"。两处仍然直接用真实时间，刻意如此：
   *              ① `logger.ts` 的日志时间戳（pino 内部取，且必须是真实挂钟，
   *                 否则排障时拿到的"日志时间"是假的）；
   *              ② `adapters/webhooks.ts` 的 `now()` 兜底值——它只在 DB 没返回时间时用到，
   *                 且会立刻与 DB 时钟做减法（跨时钟相减的风险见 app/pay-callback.ts）。
   */
  clock: Clock;
  /**
   * 标识符生成器（F10 端口）。**必填**：装配时注入 `systemIdGen`（生产）或 `stubIdGen`（测试）。
   *
   * @why 与 `clock` 成对：id 也是"看着像纯函数、其实依赖全局状态"的输入。
   *      必填而不是可选的理由完全相同——可选就一定有人不传，然后退回 `randomUUID()`，
   *      于是"单号冲突重试"（D32）这条路径除了靠运气撞上一次之外永远测不到。
   * @limitation `uuid()` 只用于**内部键**（`orders.id`）；对外一律用 `order_no`，
   *              且必须校验归属（@see readOwnedOrder 的 @why：id 不是能力凭证）。
   */
  idGen: IdGen;
  logger: Logger;
  auth: AuthConfig;
  /**
   * 运行环境。**刻意作为显式入参而不是读 `process.env.NODE_ENV`**：
   * 隐式全局会让"这个行为由谁决定"不可见，也让测试必须改进程环境才能覆盖另一分支；
   * 显式入参则逼调用方在装配时回答一次"这是什么环境"。
   * `production` 下 `mountSkeleton` 直接抛错（见 SEC2 闸门）。
   * `test` 与 `development` 同级（D17）——Vitest 会把 NODE_ENV 设成 test。
   */
  env: 'development' | 'staging' | 'test' | 'production';
  /**
   * 身份状态查询（D25）。**可选**：不传则只验 JWT、不查库（骨架期与单元测试用）。
   * 生产装配必须传，否则改密 / 封禁后旧 token 在有效期内仍可用。
   */
  identity?: IdentityCheck | undefined;
}

/** 骨架路由前缀：显式标注"脚手架"，防止被误当成正式 API。 */
const PREFIX = '/api/v1/skeleton';

/**
 * 读一张**确定属于该用户**的订单。
 *
 * @why `order_id` 是标识符，不是能力凭证。只鉴权"你是登录用户"不校验"这张单是不是你的"，
 *      后果是任何人拿到别人的单号就能读地址/金额快照；骨架期更严重——
 *      `simulate-paid` 能把**别人**的单直接改成已支付。
 *      UUID 不可猜 ≠ 不可泄漏：单号会出现在日志、邮件、客服对话、浏览器历史里。
 *
 * @tradeoff 归属不符一律抛 **40400 而不是 40300**：403 会确认"这个 id 存在"，
 *           于是攻击者可用 403/404 的差异枚举出全站有效订单号（存在性探测）。
 *           代价：真正的用户看到"订单不存在"而不是"没权限"，自排障时略难——
 *           用**日志**区分（details 里记 `owner_mismatch`），不靠响应体区分。
 * @limitation 一次 SELECT 后再比对 user_id，而不是把 user_id 直接写进 WHERE 后再判"不存在"。
 *            后者少一次分支但**无法区分两种成因**，日志里就只剩一个 40400，
 *            排障时无法回答"这张单不存在"还是"这张单不是他的"。
 *
 * @throws {AppError} 40400（不存在，或存在但不属于该用户）
 */
async function readOwnedOrder(
  db: Db,
  orderId: string,
  userId: string,
): Promise<{ id: string; order_no: string; status: string }> {
  const rows = await db`
    select id, order_no, status, user_id from orders where id = ${orderId}
  `;
  const row = rows[0];
  if (row === undefined) throw new AppError(40400, { order_id: orderId });
  if (String(row.user_id) !== userId) {
    throw new AppError(40400, { order_id: orderId, reason: 'owner_mismatch' });
  }
  return { id: String(row.id), order_no: String(row.order_no), status: String(row.status) };
}

export function mountSkeleton(app: Express, deps: SkeletonDeps): void {
  // ── 0. 环境闸门：骨架**进不了生产**（SEC2）────────────────────────────────
  // @why `/skeleton/orders/:id/simulate-paid` 会绕过机构验签直接把订单改成 paid，
  //      `/pay/callback/mock` 只认我们自己约定的 HMAC。这两条一旦进生产，
  //      等于"任何人/任何脚本都能把任意订单标记成已支付"——不是信息泄漏，是**可以直接骗取发货**。
  //      骨架在业务期（I1）要整体删除，在那之前靠这道闸门兜住。
  // @tradeoff 选择"启动时抛错"而不是"挂上后返回 404"：抛错是**最大声**的失败，
  //           符合本项目"配置错必须在进程启动时就炸"的既有原则（见 config.ts 抬头）。
  //           代价：生产误挂载 = 发布失败（Render 会继续跑旧版本）而不是"骨架不可用"——
  //           这个代价是刻意接受的：宁可发布失败，也不要留一条能改订单状态的口子。
  // @limitation 抛错发生在**挂载之前**，所以不会留下"部分注册"的路由。
  if (deps.env === 'production') {
    deps.logger.error('skeleton_mount_refused', { env: deps.env, result: 'refused' });
    throw new Error(
      '骨架路由不得挂载到生产环境：/api/v1/skeleton/* 与 /api/v1/pay/callback/mock ' +
        '可绕过机构验签改订单状态（业务期 I1 应整体删除本文件）',
    );
  }

  // ── 1. 建单：鉴权 + 幂等 + 事务写库 ──────────────────────────────────────
  app.post(
    `${PREFIX}/orders`,
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);

          const clientKey = req.header('idempotency-key');
          if (clientKey === undefined || clientKey.trim().length === 0) {
            throw new AppError(40001, { reason: '缺少 Idempotency-Key 头' });
          }

          // 建单的事件在这里收集：**幂等重放时 handler 根本不执行 → 天然不会重复发**。
          // @why 不能用 withUnitOfWork 包一层：runInTx 自己就是事务，
          //      而事务里禁止再开事务（adapters/db.ts @limitation 二）。
          //      所以这里用"手工收集 + 提交后分发"，与 withUnitOfWork 是同一个语义的两种写法。
          const pendingEvents: DomainEvent[] = [];
          const result = await deps.idempotency.runInTx(
            {
              key: scopeKey({ userId: sub, route: 'skeleton.createOrder', clientKey }),
              userId: sub,
              route: 'skeleton.createOrder',
              // N3：指纹素材必须传——不传则指纹恒为 ''，40908 是死代码，
              //     客户端复用键的 bug 会被静默吞掉（机制与接线必须成对存在）
              request: req.body,
              // 租约易主等并发事故必须落 error 日志（idempotency.ts @limitation 四）
              logger: deps.logger,
            },
            // N2：单事务模式——占位、建单、事件、结果写回同一事务，崩溃 = 整体回滚。
            // handler 内只用 tx（db.ts @limitation 二），禁止再开嵌套事务。
            async (tx) => {
              // id 与 order_no 分开：order_no 是给用户看的（YYMMDD-XXXXXX），id 是内部键
              // id 与单号都从注入的 IdGen 来：业务侧不认识 randomUUID / randomOrderSeq
              const orderId = `sk-${deps.idGen.uuid()}`;
              // 日期段取 **JST 业务日**：规则在 domain，时钟从装配处来（禁止在这里 `new Date()`）
              const orderNo = buildOrderNo(deps.clock, deps.idGen.orderSeq());
              await tx`
                insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                    total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
                values (${orderId}, ${orderNo}, ${sub}, 'created', 1000, 0, 0, 1000, 500,
                        '{}'::jsonb, '{}'::jsonb, 'SKELETON', now() + interval '30 minutes')
              `;
              await tx`
                insert into order_events (order_id, status, actor) values (${orderId}, 'created', ${`user:${sub}`})
              `;
              deps.logger.info('skeleton_order_created', {
                order_id: orderId,
                replayed: false,
                result: 'ok',
              });
              pendingEvents.push({
                name: 'order.created',
                at: deps.clock.now().toISOString(),
                orderId,
                payload: { order_no: orderNo },
              });
              return {
                status: 201,
                body: { order_id: orderId, order_no: orderNo, status: 'created' as const },
              };
            },
          );
          // 同上：事务已提交（或本次是重放）之后才分发。
          // 重放时 pendingEvents 为空 → 不会把"订单已创建"说两遍。
          deps.events.publishAll(pendingEvents);
          res.status(result.status).json(result.body);
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  // ── 3. 模拟触发支付成功（骨架专用，供小程序壳按钮调用）─────────────────────
  // @why F6c 要求"小程序壳按钮 → 落库 → 触发模拟支付回调 → 状态回写"能在真机上走一遍。
  //      真实的回调是机构打给我们的（小程序端签不了名），所以骨架期需要这个入口代替机构。
  // @limitation **业务期必须删除**：它会绕过验签直接改订单状态，留在生产等于任何人都能把单改成已支付。
  //              同 markPaid() 复用状态回写逻辑，避免"模拟能过、真实回调失败"的分叉。
  app.post(
    `${PREFIX}/orders/:id/simulate-paid`,
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const orderId = paramId(req.params.id);
          // 先确认"这张单是他的"再改状态：否则这个骨架端点等于"任何人都能把别人的单改成已支付"
          await readOwnedOrder(deps.db, orderId, sub);
          await markOrderPaid(deps.db, deps.events, deps.clock, orderId);
          deps.logger.info('skeleton_simulate_paid', { order_id: orderId, result: 'paid' });
          res.json({ order_id: orderId, status: 'paid' });
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  // ── 4. 读回：证明状态真的回写了（端到端测试的最后一环）────────────────────
  app.get(
    `${PREFIX}/orders/:id`,
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const orderId = paramId(req.params.id);
          const row = await readOwnedOrder(deps.db, orderId, sub);
          // 顺带把当前 trace_id 回给调用方：便于端到端断言"日志与响应是同一条链"
          res.json({
            order_id: row.id,
            order_no: row.order_no,
            status: row.status,
            trace_id: currentContext().trace_id,
          });
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
