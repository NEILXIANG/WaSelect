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
import { requireRole, type AuthConfig } from './app/auth.js';
import { currentContext } from './context.js';
import { withTransaction, type Db } from './adapters/db.js';
import { AppError } from './errors.js';
import { scopeKey, type IdempotencyExecutor } from './ports/idempotency.js';
import type { Logger } from './logger.js';
import type { IdentityCheck } from './adapters/identity.js';
import { payloadHash, type WebhookStore } from './ports/webhooks.js';

export interface SkeletonDeps {
  db: Db;
  /**
   * 回调事件存储（F10 端口）。**必填**：装配时由 `createWebhookStore(db)` 注入。
   *
   * @why 走端口而不是让骨架自己 import 适配器：骨架是"业务怎么用存储"的第一份示范，
   *      它一开始就依赖具体实现的话，后面所有业务代码都会照抄——
   *      分层就只剩目录好看了。这里必填而不是可选，是为了让"装配时必须回答一次"
   *      这个约束有强制力（可选就会有人不传，然后偷偷退化）。
   */
  webhooks: WebhookStore;
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
  logger: Logger;
  auth: AuthConfig;
  /** 模拟回调的 HMAC 密钥（骨架期；真实通道验签在 F11，见 @limitation 二）。 */
  callbackSecret: string;
  /**
   * 回调早到的宽限期（毫秒，AJ-32）：回调到达时订单不存在，
   * 距事件**首次**到达不超过这个时长 → 503 让机构重发（processed_at 保持 NULL）；
   * 超过 → 2xx 收下 + error 告警 + 落 `unmatched:*` 转对账。
   */
  callbackOrderGraceMs: number;
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
              const orderId = `sk-${randomUUID()}`;
              const orderNo = newOrderNo();
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
        const claim = await deps.webhooks.claim(webhook);
        if (claim.state === 'handled') {
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
        /**
         * N22：`inflight` = **另一个请求正在处理这个事件**（租约未过期）。
         * @why 这里必须回 503 而不是 2xx：2xx 会让机构认为"处理完了"从而停止重发，
         *      而我们这侧若那一次处理最终失败（进程崩了），就没有第二次机会了
         *      ——只能等每日对账（F13），而"钱到单未付"多滞留一天是不可接受的。
         *      503 + Retry-After 让机构稍后重发，届时要么读到结果（handled → 2xx），
         *      要么租约已过期可以接管（retry）——两条路都通向正确处理。
         * @why 不在这里**等待**对方处理完（像幂等那样轮询）：
         *      回调的响应时间要尽量短（机构侧通常有 5–30s 超时），
         *      而机构的重发机制本来就是为"稍后再试"设计的，等它重发比我们占着连接更划算。
         */
        if (claim.state === 'inflight') {
          deps.logger.info('webhook_inflight', {
            provider: webhook.provider,
            result: 'deferred',
            ctx: { event_id: webhook.eventId },
          });
          res
            .status(503)
            .set('retry-after', '10')
            .json({ received: false, reason: 'already_processing' });
          return;
        }
        // 走到这里：claim.state 是 'new' 或 'retry'，且 claim.token 一定存在——
        // 本次是唯一持有者，处理结果由它携带令牌写回（N22 栅栏）

        // ── 冲突分层（AJ-32/N4/N13，取代旧的"一律 2xx + warn"）────────────────
        // ① 订单不存在 + 宽限期内 → **503**：让机构的重发机制替我们兜底，
        //    processed_at 保持 NULL（对账信号 + 重发能补上）。
        //    旧行为是一律 2xx——"可重试"的登记被 200 抵消，机构永不重发（N4）。
        // ② 订单不存在 + 超过宽限期 → 2xx + **error** 告警 + 落 unmatched 转对账：
        //    脏回调不该无限占用机构重发队列，但"钱到单未付"也绝不能静默。
        // ③ 订单已是 paid → paid:already + **info**：同一订单的另一事件类型到达是
        //    正常形态（N13：先 payment_intent.succeeded 后 checkout.session.completed），
        //    告警会淹没真正的冲突。
        // ④ 其余状态冲突（expired/cancelled 等）→ 2xx + warn：重发不会变，靠人查。
        try {
          await markPaid(deps.db, orderId);
        } catch (e) {
          const code = e instanceof AppError ? e.code : 0;
          if (code === 40400) {
            // ⚠️ 用 **DB 时钟**做减法（claim.nowAt 与 firstReceivedAt 同源）：
            //    应用时钟与 DB 时钟不同源，拿 Date.now() 减 received_at 会让宽限期被时钟偏移扭曲
            //    ——最坏情况是"钱到单未付"被静默判成超期（@see webhooks.ts ClaimResult.nowAt）
            const elapsedMs = claim.nowAt.getTime() - claim.firstReceivedAt.getTime();
            // ⚠️ 用严格小于（`elapsedMs < graceMs`），不是 `<=`：
            //    "宽限期 = 0"的语义必须是**零宽限**（任何早到都立即转 unmatched），
            //    若写成 `<=`，则 elapsed 恰好为 0 时仍算宽限期内——
            //    在 DB 时钟下"刚到"的 elapsed 就是 0，于是零宽限配置永远走不到超期分支
            //    （本文件那条 graceMs=0 的用例原先是靠"应用时钟比 DB 时钟快几毫秒"才偶然成立的）。
            if (elapsedMs < deps.callbackOrderGraceMs) {
              deps.logger.warn('callback_early', {
                order_id: orderId,
                result: 'retry_scheduled',
                ctx: { event_id: webhook.eventId, grace_ms: deps.callbackOrderGraceMs },
              });
              /**
               * ⚠️ **必须交还租约**（N22 的补丁，被自己的 e2e 抓出来）：
               *    这个请求到此就结束了，它并不在"处理中"，租约却还挂在它名下 10 秒。
               *    不交还的话，机构按 Retry-After 发来的重投会被判成 `inflight`（再吃一个 503），
               *    "早到 → 重发 → 补上"这条链被租约自己掐断——而它正是"钱到单未付"的兜底。
               *    `processed_at` 保持 NULL 不变：那才是"待办"信号（对账 + 允许被接管）。
               */
              await deps.webhooks.releaseLease({ ...webhook, token: claim.token ?? '' });
              // Retry-After 给机构一个重发节奏提示（30s 远小于宽限期，又不至于打爆我们）
              res
                .status(503)
                .set('retry-after', '30')
                .json({ received: false, order_id: orderId, reason: 'order_not_found_yet' });
              return;
            }
            deps.logger.error('callback_unmatched', {
              order_id: orderId,
              result: 'unmatched',
              ctx: { event_id: webhook.eventId, elapsed_ms: elapsedMs },
            });
            await deps.webhooks.finish({
              ...webhook,
              result: 'unmatched:order_not_found',
              token: claim.token ?? '',
              note: '超过宽限期订单仍不存在：转入对账任务（F13），机构不必再重发',
            });
            res.json({ received: true, order_id: orderId, ignored: 'unmatched' });
            return;
          }
          if (code === 40902) {
            const from = (e as AppError).details as { from?: unknown } | undefined;
            if (from?.from === 'paid') {
              deps.logger.info('paid_already', {
                order_id: orderId,
                result: 'ignored',
                ctx: { event_id: webhook.eventId },
              });
              await deps.webhooks.finish({
                ...webhook,
                result: 'paid:already',
                token: claim.token ?? '',
                note: '同单另一事件类型到达，订单已是 paid（N13：正常形态，不是异常）',
              });
              res.json({ received: true, order_id: orderId, ignored: 'paid:already' });
              return;
            }
            deps.logger.warn('callback_conflict', {
              order_id: orderId,
              conflict: 'status_conflict',
              result: 'ignored',
            });
            await deps.webhooks.finish({
              ...webhook,
              result: 'ignored:status_conflict',
              token: claim.token ?? '',
              note: '业务冲突：重发也不会变，靠对账而非重试',
            });
            res.json({ received: true, order_id: orderId, ignored: 'status_conflict' });
            return;
          }
          throw e;
        }
        // 栅栏（N22）：带令牌写结果；false = 租约已易主，我们是迟到的旧持有者
        const wrote = await deps.webhooks.finish({
          ...webhook,
          result: 'paid',
          token: claim.token ?? '',
        });
        if (!wrote) {
          deps.logger.warn('webhook_result_not_written', {
            provider: webhook.provider,
            result: 'lease_lost',
            ctx: { event_id: webhook.eventId },
          });
        }
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
