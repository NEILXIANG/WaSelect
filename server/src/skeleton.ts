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

export interface SkeletonDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  /** 模拟回调的 HMAC 密钥（骨架期；真实通道验签在 F11，见 @limitation 二）。 */
  callbackSecret: string;
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
  // ── 1. 建单：鉴权 + 幂等 + 事务写库 ──────────────────────────────────────
  app.post(`${PREFIX}/orders`, requireRole('user', deps.auth), (req, res, next) => {
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
  });

  // ── 2. 模拟支付回调：原始报文验签 + 事务状态回写 ──────────────────────────
  app.post(MOCK_CALLBACK_PATH, (req, res, next) => {
    void (async () => {
      try {
        // 必须拿到**未经解析的字节**才能验签——路由层已为这个前缀配了 express.raw()
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const signature = req.header('x-mock-signature') ?? '';
        if (!verifySignature(raw, signature, deps.callbackSecret)) {
          // 验签失败绝不回显细节（50002）
          throw new AppError(50002);
        }
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        const orderId = (parsed as { order_id?: unknown } | null)?.order_id;
        if (typeof orderId !== 'string' || orderId.length === 0) {
          throw new AppError(40001, { reason: '回调缺少 order_id' });
        }

        await markPaid(deps.db, orderId);
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
  app.post(`${PREFIX}/orders/:id/simulate-paid`, requireRole('user', deps.auth), (req, res, next) => {
    void (async () => {
      try {
        const orderId = paramId(req.params.id);
        await markPaid(deps.db, orderId);
        deps.logger.info('skeleton_simulate_paid', { order_id: orderId, result: 'paid' });
        res.json({ order_id: orderId, status: 'paid' });
      } catch (e) {
        next(e);
      }
    })();
  });

  // ── 4. 读回：证明状态真的回写了（端到端测试的最后一环）────────────────────
  app.get(`${PREFIX}/orders/:id`, requireRole('user', deps.auth), (req, res, next) => {
    void (async () => {
      try {
        const orderId = paramId(req.params.id);
        const rows = await deps.db`
          select id, order_no, status from orders where id = ${orderId}
        `;
        const row = rows[0];
        if (row === undefined) throw new AppError(40400, { order_id: orderId });
        // 顺带把当前 trace_id 回给调用方：便于端到端断言"日志与响应是同一条链"
        res.json({
          order_id: String(row.id),
          order_no: String(row.order_no),
          status: String(row.status),
          trace_id: currentContext().trace_id,
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
