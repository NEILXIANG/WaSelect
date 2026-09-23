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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import { formatOrderNo, jstDateShort, randomOrderSeq } from '@waselect/shared';
import { requireRole, type AuthConfig } from './auth.js';
import { currentContext } from './context.js';
import { withTransaction, type Db } from './db.js';
import { AppError } from './errors.js';
import { scopeKey, withIdempotency } from './idempotency.js';
import type { Logger } from './logger.js';
import type { IdentityCheck } from './identity.js';
import { claimWebhookEvent, finishWebhookEvent, payloadHash } from './webhooks.js';

export interface SkeletonDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  /** 模拟回调的 HMAC 密钥（骨架期；真实通道验签在 F11，见 @limitation 二）。 */
  callbackSecret: string;
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
/** 模拟回调路径：**必须**登记到 createHttpApp 的 rawBodyPaths，否则验签拿到的是解析后的 body。 */
export const MOCK_CALLBACK_PATH = '/api/v1/pay/callback/mock';

/**
 * 恒定时间比较 HMAC。
 * @why 用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同字节就返回，
 *      耗时差异可被用来逐字节猜出正确签名。验签代码里 `===` 就是缺陷。
 */
function verifySignature(raw: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // 长度不等时 timingSafeEqual 会抛错，必须先比长度——这一步泄漏的只是长度，不影响安全性
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 生成订单号：`YYMMDD-XXXXXX`，取自 shared（技术文档 §1：禁止自增）。 */
function newOrderNo(): string {
  return formatOrderNo(jstDateShort(new Date()), randomOrderSeq());
}

/**
 * 把订单置为 paid（事务 + `for update` + 追加审计事件）。
 *
 * @why 抽成共用函数是因为**两个入口都要做同一件事**：真实回调（验签后）与骨架的"模拟触发"。
 *      若各写一份，改一处漏一处就会出现"模拟能过、真实回调失败"这类只在生产暴露的差异。
 * @throws {AppError} 40400（订单不存在）/ 40902（状态不是 created，多半是回调重发）
 */
async function markPaid(db: Db, orderId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    // for update：并发回调（机构重发）时排队，避免两次都读到 'created' 各写一次事件
    const rows = await tx`select status from orders where id = ${orderId} for update`;
    const current = rows[0]?.status;
    if (current === undefined) throw new AppError(40400, { order_id: orderId });
    if (current !== 'created') throw new AppError(40902, { from: current, to: 'paid' });
    await tx`
      update orders set status = 'paid', paid_at = now(), updated_at = now() where id = ${orderId}
    `;
    await tx`
      insert into order_events (order_id, status, actor) values (${orderId}, 'paid', 'system')
    `;
  });
}

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

/**
 * 收敛路径参数。
 * @why Express 5 的类型里 `req.params.x` 是 `string | string[]`（通配/重复参数会产生数组），
 *      `noUncheckedIndexedAccess` 下还可能是 `undefined`。直接拼进 SQL 会有两种静默后果：
 *      ① `undefined` 被 postgres.js 当 NULL → 查询返回空，错误从 400 变成 404，排查方向全错；
 *      ② 数组被转成字符串 → 查到一个根本不存在的 id。
 *      所以在**所有**用到 params 的地方统一先收敛，而不是在每个 handler 里各判一次。
 */
function paramId(value: string | string[] | undefined): string {
  const one = Array.isArray(value) ? value[0] : value;
  if (typeof one !== 'string' || one.length === 0) {
    throw new AppError(40001, { reason: '缺少或非法路径参数' });
  }
  return one;
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

          const result = await withIdempotency(
            deps.db,
            {
              key: scopeKey({ userId: sub, route: 'skeleton.createOrder', clientKey }),
              userId: sub,
              route: 'skeleton.createOrder',
              // 租约易主等并发事故必须落 error 日志（idempotency.ts @limitation 四）
              logger: deps.logger,
            },
            async () => {
              // id 与 order_no 分开：order_no 是给用户看的（YYMMDD-XXXXXX），id 是内部键
              const orderId = `sk-${randomUUID()}`;
              const orderNo = newOrderNo();
              // 事务内只用 tx（@see db.ts @limitation 二：用外层 db 会取到另一条连接、看不到未提交数据）
              await withTransaction(deps.db, async (tx) => {
                await tx`
                insert into orders (id, order_no, user_id, status, items_jpy, shipping_jpy, duty_jpy,
                                    total_jpy, weight_g, fx_snapshot, address_snapshot, terms_version, expires_at)
                values (${orderId}, ${orderNo}, ${sub}, 'created', 1000, 0, 0, 1000, 500,
                        '{}'::jsonb, '{}'::jsonb, 'SKELETON', now() + interval '30 minutes')
              `;
                await tx`
                insert into order_events (order_id, status, actor) values (${orderId}, 'created', ${`user:${sub}`})
              `;
              });
              deps.logger.info('skeleton_order_created', {
                order_id: orderId,
                replayed: false,
                result: 'ok',
              });
              return {
                status: 201,
                body: { order_id: orderId, order_no: orderNo, status: 'created' as const },
              };
            },
          );
          res.status(result.status).json(result.body);
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  // ── 2. 模拟支付回调：原始报文验签 + 事务状态回写 ──────────────────────────
  app.post(MOCK_CALLBACK_PATH, (req, res, next) => {
    void (async () => {
      try {
        // 必须拿到**未经解析的字节**才能验签——路由层已为这个前缀配了 express.raw()
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const signature = req.header('x-mock-signature') ?? '';
        if (!verifySignature(raw, signature, deps.callbackSecret)) {
          // 40103：入站方的问题，不是我们的故障（@see shared/errors.ts 40103 的注释）
          throw new AppError(40103);
        }

        // ⚠️ 必须自己 try：这里的 JSON.parse 抛的是**我们自己的** SyntaxError，
        //    不带 body-parser 的 `type` / `status` 标记，所以 http.ts 的 isBodyParseError
        //    认不出来，会被当成未归类异常折叠成 50000 → 机构收到 500 就会一直重试。
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new AppError(40001, { reason: '回调报文不是合法 JSON' });
        }
        const orderId = (parsed as { order_id?: unknown } | null)?.order_id;
        if (typeof orderId !== 'string' || orderId.length === 0) {
          throw new AppError(40001, { reason: '回调缺少 order_id' });
        }

        // ── 回调登记（D3）：先落一行"我们收到过"，再去处理 ──────────────────────
        // @why 登记必须在**处理之前**：只有"收到"这件事是确定的，处理结果可能失败、可能冲突。
        //      反过来（处理完才登记）会让"处理崩溃的回调"在表里彻底消失，
        //      于是对账任务永远看不到它——那正是最需要被看到的那一类。
        const eventIdRaw = (parsed as { event_id?: unknown } | null)?.event_id;
        const webhook = {
          provider: 'mock',
          // 机构没给 event_id 时（骨架的模拟回调就没有），用原文摘要兜底：
          // 内容完全相同的重复投递因此也能被识别
          eventId:
            typeof eventIdRaw === 'string' && eventIdRaw.length > 0
              ? eventIdRaw
              : `sha256:${payloadHash(raw)}`,
          eventType: 'payment.succeeded',
          hash: payloadHash(raw),
        };
        const claim = await claimWebhookEvent(deps.db, webhook);
        if (claim === 'handled') {
          // 重复投递：直接收下，不重复处理——但必须留一条可检索的日志，
          // 否则"机构在重发"这件事会被当成"一切正常"
          deps.logger.info('webhook_duplicate', {
            order_id: orderId,
            provider: webhook.provider,
            result: 'ignored',
            ctx: { event_id: webhook.eventId },
          });
          res.json({ received: true, order_id: orderId, duplicate: true });
          return;
        }
        // claim === 'retry'：上次没处理成功（订单当时还不存在 / 进程崩了），这一次重新走一遍

        // ── 业务冲突：一律 2xx + 我方告警，绝不回 4xx/5xx ──────────────────────
        // @why 机构对**任何非 2xx**都会按退避重发（Stripe 重试 3 天、微信同理）。
        //      "这张单不存在"/"已经是 paid 了"这类冲突**重发一万次也不会变**，
        //      回 404/409 等于让机构无限重发，把它的重试队列和我们的错误率一起打满。
        //      正确做法：收下（2xx），自己记 warn 告警，由人/对账任务去查。
        // @limitation "收下"不等于"忽略"：必须落一条可检索的告警日志，
        //             否则"钱到了但没单"（订单不存在）会彻底静默——那是最贵的一类事故。
        try {
          await markPaid(deps.db, orderId);
        } catch (e) {
          const code = e instanceof AppError ? e.code : 0;
          if (code === 40400 || code === 40902) {
            const conflict = code === 40400 ? 'order_not_found' : 'status_conflict';
            deps.logger.warn('callback_conflict', {
              order_id: orderId,
              conflict,
              result: 'ignored',
            });
            await finishWebhookEvent(deps.db, {
              ...webhook,
              result: `ignored:${conflict}`,
              note: '业务冲突：重发也不会变，靠对账而非重试',
            });
            res.json({ received: true, order_id: orderId, ignored: conflict });
            return;
          }
          throw e;
        }
        await finishWebhookEvent(deps.db, { ...webhook, result: 'paid' });
        deps.logger.info('skeleton_payment_callback', { order_id: orderId, result: 'paid' });
        res.json({ received: true, order_id: orderId });
      } catch (e) {
        next(e);
      }
    })();
  });

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
          await markPaid(deps.db, orderId);
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
