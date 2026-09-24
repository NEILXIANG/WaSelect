/**
 * 职责：L3 端到端测试的公共装配（F6c）——起一个"什么都真"的骨架服务。
 *
 * @why 每个 e2e 文件都自己拼一遍 logger/app/db，就会出现"这个文件少配了 rawBodyPaths"，
 *      而它偏偏还能通过——因为那个文件根本没测回调。装配只有一处，少配的代价立刻在所有文件显现。
 *
 * 真实的东西：真端口、真库、真事务、真 JWT、真 HMAC 验签、真 pino 序列化。
 * 假的只有支付机构本身（骨架期应当如此，F11 换成 Stripe 真实验签）。
 *
 * @limitation `withRawBody` 默认 **true**。回调验签依赖未经解析的原始字节，
 *              "配错"时的症状是验签永远失败，排查会误导向密钥/机构——
 *              所以 `skeleton.e2e.test.ts` 里有一条专门的断链用例把它钉住。
 */
import { signToken, type AuthConfig } from '../../server/src/app/auth.js';
import type { Db } from '../../server/src/adapters/db.js';
import { createHttpApp, listen, type StartedServer } from '../../server/src/http.js';
import { createLogger } from '../../server/src/logger.js';
import { MOCK_CALLBACK_PATH, mountSkeleton } from '../../server/src/skeleton.js';
import { createWebhookStore } from '../../server/src/adapters/webhooks.js';
import { createIdempotencyExecutor } from '../../server/src/adapters/idempotency.js';
import { createEventBus } from '../../server/src/adapters/event-bus.js';
import { systemIdGen } from '../../server/src/adapters/ids.js';
import type { IdGen } from '../../server/src/ports/ids.js';
import { registerBusinessEventLog } from '../../server/src/app/business-events.js';
import { MemorySink } from '../helpers/memory-sink.js';
import { fixedClock } from '../helpers/fixed-clock.js';

export const E2E_AUTH: AuthConfig = { secret: 'e2e-jwt-secret-'.repeat(3), issuer: 'waselect-e2e' };
export const E2E_CALLBACK_SECRET = 'mock-callback-secret';
/** 全程只用一个链路 ID，便于断言"几跳日志是同一条链"。 */
export const E2E_TRACE = 'e2e-trace-0001';
export const E2E_USER = 'u-e2e';

/**
 * e2e 的"现在"：**固定值**，且刻意远离真实今天。
 *
 * @why 时钟一旦固定，单号的日期段就成了**可断言的常量**——
 *      端到端层面因此能证明"业务真的用了装配处注入的那个时钟"，
 *      而不是某处偷偷 `new Date()`（那种写法在真实时间下测不出来）。
 * @why 选 `2026-01-02T15:30:00Z` 这个时刻：它刚过 JST 跨日点（UTC 15:00），
 *      UTC 日与本机的本地日都还是 01-02，只有 JST 已经是 01-03——
 *      于是"用错时区"和"用了注入时钟之外的时钟"两种错法都会立刻变红。
 */
export const E2E_NOW = '2026-01-02T15:30:00.000Z';
/**
 * `E2E_NOW` 对应的单号日期段（JST `YYMMDD`）。
 *
 * ⚠️ 刻意写成**字面量**而不是再调一次 `jstDateShort()`：
 *    后者等于"用被测的函数去算期望值"，函数算错了测试照样绿。
 */
export const E2E_ORDER_NO_DATE = '260103';

export interface SkeletonServer {
  server: StartedServer;
  /** 形如 `http://127.0.0.1:<port>` */
  base: string;
  sink: MemorySink;
}

export async function startSkeleton(
  db: Db,
  opts: { withRawBody?: boolean; graceMs?: number; now?: string; idGen?: IdGen } = {},
): Promise<SkeletonServer> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  const app = createHttpApp({
    logger,
    rawBodyPaths: (opts.withRawBody ?? true) ? [MOCK_CALLBACK_PATH] : [],
    silentPaths: ['/healthz'],
    mount: (a) => {
      // 与生产同一条装配路径：总线与订阅者都在装配处接好（不复制一份"测试专用总线"）
      const events = createEventBus(logger);
      registerBusinessEventLog(events, logger);
      // env 显式给 development：骨架在 production 下会拒绝挂载（SEC2 闸门），装配处必须回答一次
      mountSkeleton(a, {
        db,
        // 与生产同一条装配路径：实现在装配处注入，业务侧只见端口
        webhooks: createWebhookStore(db),
        idempotency: createIdempotencyExecutor(db),
        events,
        // 与生产同一条装配路径：生产注入 systemClock，这里注入固定时钟。
        // 业务代码不知道自己拿到的是哪一个——这正是"时间可测"的落点。
        clock: fixedClock(opts.now ?? E2E_NOW),
        // 默认用真实 IdGen（e2e 多数用例要建多张单，固定 id 会撞唯一约束）；
        // 需要"断言 id 就是某个值"的用例显式传 `idGen`（见 stubIdGen 的 @limitation）
        idGen: opts.idGen ?? systemIdGen,
        logger,
        auth: E2E_AUTH,
        callbackSecret: E2E_CALLBACK_SECRET,
        env: 'development',
        // 默认与生产一致（AJ-32 的 15 分钟）；需要"立即超过宽限期"的用例传 0
        callbackOrderGraceMs: opts.graceMs ?? 900_000,
      });
    },
  });
  const server = await listen(app);
  return { server, base: `http://127.0.0.1:${server.port}`, sink };
}

/** 签发一个骨架用的用户 token。 */
export function userToken(sub: string = E2E_USER): Promise<string> {
  return signToken({ sub, role: 'user' }, E2E_AUTH);
}
