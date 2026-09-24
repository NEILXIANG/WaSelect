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
import { MemorySink } from '../helpers/memory-sink.js';

export const E2E_AUTH: AuthConfig = { secret: 'e2e-jwt-secret-'.repeat(3), issuer: 'waselect-e2e' };
export const E2E_CALLBACK_SECRET = 'mock-callback-secret';
/** 全程只用一个链路 ID，便于断言"几跳日志是同一条链"。 */
export const E2E_TRACE = 'e2e-trace-0001';
export const E2E_USER = 'u-e2e';

export interface SkeletonServer {
  server: StartedServer;
  /** 形如 `http://127.0.0.1:<port>` */
  base: string;
  sink: MemorySink;
}

export async function startSkeleton(
  db: Db,
  opts: { withRawBody?: boolean; graceMs?: number } = {},
): Promise<SkeletonServer> {
  const sink = new MemorySink();
  const logger = createLogger({ env: 'development', destination: sink });
  const app = createHttpApp({
    logger,
    rawBodyPaths: (opts.withRawBody ?? true) ? [MOCK_CALLBACK_PATH] : [],
    silentPaths: ['/healthz'],
    mount: (a) =>
      // env 显式给 development：骨架在 production 下会拒绝挂载（SEC2 闸门），装配处必须回答一次
      mountSkeleton(a, {
        db,
        // 与生产同一条装配路径：实现在装配处注入，业务侧只见端口
        webhooks: createWebhookStore(db),
        idempotency: createIdempotencyExecutor(db),
        logger,
        auth: E2E_AUTH,
        callbackSecret: E2E_CALLBACK_SECRET,
        env: 'development',
        // 默认与生产一致（AJ-32 的 15 分钟）；需要"立即超过宽限期"的用例传 0
        callbackOrderGraceMs: opts.graceMs ?? 900_000,
      }),
  });
  const server = await listen(app);
  return { server, base: `http://127.0.0.1:${server.port}`, sink };
}

/** 签发一个骨架用的用户 token。 */
export function userToken(sub: string = E2E_USER): Promise<string> {
  return signToken({ sub, role: 'user' }, E2E_AUTH);
}
