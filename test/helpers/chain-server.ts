/**
 * 职责：**业务链路测试的共用装配**——用与生产同一条装配路径（`loadConfig` → `createHttpApp`
 *      含 `rawBodyPaths` → `mountAllRoutes` → 业务事件订阅者）起一个真服务，
 *      外加链路测试反复要用的几样东西：标准 fixture、签 token、HTTP 调用、
 *      签名的 mock 回调、跑一次关单 / 对账作业、**全表状态快照**。
 *
 * @why 链路测试的价值在"拼起来对不对"，最怕的是每个文件各抄一份装配、
 *      抄着抄着就和生产不一样了（链路矩阵 §3.3 的 harness 漂移教训）。
 *      此前 5 个 db 测试文件各有一份几乎相同的 `buildServer`，其中两份没登记
 *      `rawBodyPaths`、一份没挂业务事件订阅者——各自的用例不受影响，
 *      但任何人拿它们去测"回调 → 事件"都会得到假红或假绿。
 * @why `snapshotState` 是"零副作用"断言的唯一口径：拒绝路径 / 状态冲突 / 越权
 *      不只要"返回码对"，还要**所有相关表一行都没动**（订单、明细、事件、支付、
 *      库存、幂等键、回调登记）。逐表手写断言会漏表，前后整体 `toEqual` 不会。
 *
 * @limitation 一：`mountAllRoutes` 内部写死 `systemClock`，路由侧的时间无法注入；
 *              "到点"一律通过改库里的 `expires_at` 或给作业传未来时钟实现（与既有用例同口径）。
 * @limitation 二：快照只取**会被业务链路改动的列**，不取 `created_at/updated_at` 这类
 *              随时刻变化的列——否则"零副作用"断言会被时间戳噪声打红。
 *
 * @see server/src/app/mount.ts（生产装配）；server/src/main.ts（rawBodyPaths 同口径）；
 *      docs/测试策略与验证门禁.md §3.3；docs/自主决策记录.md AJ-174
 */
import { createHmac } from 'node:crypto';
import type { Db } from '../../server/src/adapters/db.js';
import { loadConfig } from '../../server/src/config.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import { createMemoryStorage } from '../../server/src/adapters/storage-memory.js';
import { createHttpApp, listen } from '../../server/src/http.js';
import { createLogger } from '../../server/src/logger.js';
import { mountAllRoutes } from '../../server/src/app/mount.js';
import { registerBusinessEventLog } from '../../server/src/app/business-events.js';
import { PAY_CALLBACK_PREFIX } from '../../server/src/app/pay-routes.js';
import { signToken } from '../../server/src/app/auth.js';
import { collectAppRoutes, type RouteRef } from '../../server/src/app/route-snapshot.js';
import { createSchedulerDeps } from '../../server/src/app/scheduler-start.js';
import { runSchedulerOnce } from '../../server/src/app/scheduler.js';
import { createExpireOrdersJob, EXPIRE_ORDERS_JOB } from '../../server/src/app/expire-orders.js';
import { createDailyReconciliationJob } from '../../server/src/app/daily-reconciliation.js';
import type { EventBus } from '../../server/src/ports/events.js';
import type { Logger } from '../../server/src/logger.js';
import { makeShippingRates } from '../factories/entities.js';
import { TEST_DB_URL } from '../db/test-db.js';
import { MemorySink } from './memory-sink.js';
import { fixedClock } from './fixed-clock.js';

export const CHAIN_JWT_SECRET = 'chain-test-jwt-secret-'.repeat(3);
export const CHAIN_CALLBACK_SECRET = 'chain-test-mock-callback-secret';
export const CHAIN_TERMS = 'TOS-TEST-1';

export interface ChainServer {
  url: string;
  /** 生产装配后实际挂载的路由（`collectAppRoutes` 口径）：表驱动的守卫矩阵从这里取，不手抄。 */
  routes: RouteRef[];
  sink: MemorySink;
  /** 与路由共用的同一条总线：作业分发的事件要落到同一批订阅者上（关单连带 D-50）。 */
  events: EventBus;
  logger: Logger;
  close: () => Promise<void>;
}

/** 生产形态装配（mock 通道 + dev 登录）。`extra` 覆盖/追加环境变量。 */
export async function buildChainServer(
  db: Db,
  extra: Record<string, string> = {},
): Promise<ChainServer> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'test', destination: sink });
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '1',
    HOST: '127.0.0.1',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: CHAIN_JWT_SECRET,
    PAYMENT_CHANNELS: 'mock',
    MOCK_CALLBACK_SECRET: CHAIN_CALLBACK_SECRET,
    TERMS_VERSION: CHAIN_TERMS,
    WECHAT_DEV_LOGIN: 'dev-',
    ...extra,
  });
  const events = createEventBus(logger);
  registerBusinessEventLog(events, logger);
  const app = createHttpApp({
    logger,
    // 与 main.ts 同口径：回调验签要原始字节，少这一环所有回调 50000
    rawBodyPaths: [PAY_CALLBACK_PREFIX],
    mount: (a) => {
      mountAllRoutes(a, { config, logger, db, events, storage: createMemoryStorage() });
    },
  });
  const server = await listen(app);
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    routes: collectAppRoutes(app),
    sink,
    events,
    logger,
    close: server.close,
  };
}

/**
 * 标准 fixture（与 order-routes / miniprogram-shell 同一组事实）：
 * 买家 u-1（地址 addr-1）、买家 u-2（地址 addr-2）、管理员 u-admin；
 * 厨刀 8,800 円 ×库存 5、茶杯 3,200 円 ×库存 10；占位运费表；USD/CNY 汇率。
 * 厨刀×1 + 茶杯×2 → 商品 15,200 + 运费 4,950（1830g 落 4950 档，D-46）= **20,150**。
 */
export async function seedChainFixture(db: Db): Promise<void> {
  await db`
    insert into users (id, openid, email, is_admin)
    values ('u-1', 'o-1', null, false), ('u-2', 'o-2', null, false),
           ('u-admin', 'o-admin', 'admin@example.com', true)
  `;
  await db`
    insert into products (id, title, category, price_jpy, weight_g, stock, origin_country, status)
    values ('p-knife', 'Chef Knife', 'kitchen', 8800, 620, 5, 'JP', 'active'),
           ('p-cup', 'Tea Cup', 'kitchen', 3200, 480, 10, 'JP', 'active')
  `;
  for (const s of makeShippingRates('placeholder')) {
    await db`
      insert into shipping_rates (carrier, max_weight_g, price_jpy, active)
      values (${s.carrier}, ${s.max_weight_g}, ${s.price_jpy}, ${s.active})
    `;
  }
  await db`
    insert into fx_rates (quote, rate, raw_rate, buffer, effective_from)
    values ('USD', 0.0067, 0.0065, 0.03, now() - interval '1 hour'),
           ('CNY', 0.049, 0.048, 0.03, now() - interval '1 hour')
  `;
  await db`
    insert into addresses (id, user_id, recipient, phone, line1, city, state, postal_code, country, is_default)
    values ('addr-1', 'u-1', 'Jane Doe', '+14155550123', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'US', true),
           ('addr-2', 'u-2', 'Taro Yamada', '+12125550199', '350 5th Ave', 'New York', 'NY', '10118', 'US', true)
  `;
}

export const CHAIN_ITEMS = [
  { product_id: 'p-knife', qty: 1 },
  { product_id: 'p-cup', qty: 2 },
] as const;
export const CHAIN_ITEMS_JPY = 15_200;
export const CHAIN_SHIPPING_JPY = 4950;
export const CHAIN_TOTAL_JPY = CHAIN_ITEMS_JPY + CHAIN_SHIPPING_JPY;

export async function tokenFor(
  sub: string,
  role: 'user' | 'admin' = 'user',
  ver?: number,
): Promise<string> {
  return signToken(
    { sub, role, ...(ver !== undefined ? { ver } : {}) },
    { secret: CHAIN_JWT_SECRET, issuer: 'waselect' },
  );
}

export interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

/** 一次 JSON 请求（token / 幂等键可选）。响应体解析失败时给空对象，状态码照实返回。 */
export async function call(
  srv: { url: string },
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: { token?: string; key?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.key !== undefined) headers['idempotency-key'] = opts.key;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${srv.url}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** 标准建单请求体（厨刀×1 + 茶杯×2；地址默认 addr-1）。 */
export function orderBody(addressId = 'addr-1', extra: Record<string, unknown> = {}): unknown {
  return { items: CHAIN_ITEMS, address_id: addressId, terms_version: CHAIN_TERMS, ...extra };
}

/**
 * 机构 → 服务端的 mock 回调（真 HMAC 签名、走真 rawBody 中间件）。
 * 金额/币种/机构单号默认取库里在途支付行——"按机构真实会发的内容"回调；
 * 需要构造不符时用 `override`。
 */
export async function mockCallback(
  srv: { url: string },
  db: Db,
  orderId: string,
  opts: {
    eventId: string;
    type?: string;
    override?: Partial<{ provider_ref: string; currency: string; amount_minor: number }>;
  },
): Promise<HttpResult> {
  const rows = await db`
    select provider_ref, charge_currency, charge_amount from payments
     where order_id = ${orderId} order by created_at desc limit 1
  `;
  const p = rows[0];
  const body = JSON.stringify({
    event_id: opts.eventId,
    type: opts.type ?? 'payment.succeeded',
    order_id: orderId,
    provider_ref: opts.override?.provider_ref ?? p?.['provider_ref'],
    currency: opts.override?.currency ?? p?.['charge_currency'],
    amount_minor: opts.override?.amount_minor ?? Number(p?.['charge_amount']),
  });
  const res = await fetch(`${srv.url}${PAY_CALLBACK_PREFIX}/mock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': createHmac('sha256', CHAIN_CALLBACK_SECRET).update(body).digest('hex'),
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/**
 * 跑一轮关单作业（生产的作业本体 + 生产的调度框架 + **与路由同一条总线**）。
 * `at` 给一个未来时刻即可让"到点"成立，不必改库。
 */
export async function runExpireJob(db: Db, srv: ChainServer, at: Date): Promise<void> {
  await runSchedulerOnce(
    createSchedulerDeps(db, srv.events, fixedClock(at), srv.logger, {
      name: EXPIRE_ORDERS_JOB,
    }),
    [createExpireOrdersJob()],
  );
  // ⚠️ 心跳行不在 resetTestDb 的清空范围内（D-45：看门狗要读心跳）——不删会**遗传**给别的测试文件
  //    （实测：db.db.test「job_runs 有 seed」读到多出来的 expire_orders 行而红）。
  //    与 close-session-wiring.db.test.ts 的 afterAll 同口径。
  await db`delete from job_runs where name = ${EXPIRE_ORDERS_JOB}`;
}

/** 跑一轮每日对账，返回各类异常的计数（按对账作业自己的日志口径读）。 */
export async function runDailyReconciliation(
  db: Db,
  srv: ChainServer,
  at: Date,
): Promise<Record<string, number>> {
  srv.sink.clear();
  await runSchedulerOnce(
    createSchedulerDeps(db, srv.events, fixedClock(at), srv.logger, {
      name: 'daily',
      lockKey: 'daily',
    }),
    [createDailyReconciliationJob()],
  );
  const summary = srv.sink.find('daily_reconciliation')[0];
  return (summary?.['ctx'] ?? {}) as Record<string, number>;
}

/** 对账作业某一类异常的取样 id（没有这一类异常时为空数组）。 */
export function reconciliationSample(sink: MemorySink, cls: string): string[] {
  const row = sink
    .find('reconciliation_anomaly')
    .find((r) => (r['ctx'] as { class?: string } | undefined)?.class === cls);
  return ((row?.['ctx'] as { sample_ids?: string[] } | undefined)?.sample_ids ?? []).map(String);
}

/** 某个领域事件被业务事件订阅者记下的次数（按结构化字段读，不按文本 includes）。 */
export function domainEvents(sink: MemorySink, orderId?: string): string[] {
  return sink
    .find('business_event')
    .filter((r) => orderId === undefined || r['order_id'] === orderId)
    .map((r) => String((r['ctx'] as { domain_event?: string } | undefined)?.domain_event));
}

/**
 * 全表状态快照（"零副作用"断言用）：订单 / 明细 / 事件 / 支付 / 库存 / 幂等键 / 回调登记。
 * 只取业务链路会改动的列（@limitation 二）；行按主键排序，保证前后可比。
 */
export async function snapshotState(db: Db): Promise<Record<string, unknown>> {
  const [orders, items, events, payments, stock, idem, webhooks] = await Promise.all([
    db`select id, user_id, status, total_jpy, paid_at is not null as paid, cancelled_at is not null as cancelled,
              address_snapshot from orders order by id`,
    db`select order_id, product_id, qty, unit_price_jpy, title_snapshot from order_items order by order_id, product_id`,
    db`select order_id, status, actor from order_events order by order_id, id`,
    db`select id, order_id, provider, status, charge_currency, charge_amount, paid_amount
         from payments order by order_id, created_at`,
    db`select id, stock, status, price_jpy, title from products order by id`,
    db`select key, user_id, route, status_code from idempotency_keys order by key`,
    db`select event_id, result, processed_at is not null as processed from webhook_events order by event_id`,
  ]);
  const plain = (rows: readonly unknown[]): unknown[] => rows.map((r) => ({ ...(r as object) }));
  return {
    orders: plain(orders),
    items: plain(items),
    events: plain(events),
    payments: plain(payments),
    stock: plain(stock),
    idem: plain(idem),
    webhooks: plain(webhooks),
  };
}

/**
 * 去掉回调登记表后的快照：用于"机构回调到达、只允许多一行回调登记、其它一行都不能动"的断言。
 */
export function withoutWebhooks(snap: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snap).filter(([k]) => k !== 'webhooks'));
}

/** 轮询直到 `probe()` 为真（提交后分发的订阅者是异步的）；超时抛错，不假绿。 */
export async function waitUntil(
  probe: () => Promise<boolean>,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
