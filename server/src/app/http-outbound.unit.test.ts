/**
 * 职责：「配置的数字 → 出站客户端参数」的映射 + **同源断言**（F12 遗留②）。
 *
 * @why 这一单元要防的失效不是"映射写错"，而是"**接了配置但没真的用上**"与"**两处数字漂移**"：
 *      ① 漂移：实现层留着兜底常量（`DEFAULT_TIMEOUT_MS` / `DEFAULT_BREAKER_POLICY`），
 *         配置里又有默认值。改了一处没改另一处**不报错**——
 *         表现形式是"我明明把超时改成 3 秒了，怎么还是 10 秒"（或反过来），且只有线上才知道。
 *      ② 没接上：装配处（I1-U1 起为 `app/mount.ts`，此前是 `main.ts`）如果漏传
 *         `timeoutMs`，客户端会静默回落到兜底常量，配置形同虚设，而**没有任何测试会红**。
 *      这两类都只能靠集合/数值比对兜住。
 *
 * @see ./http-outbound.ts；docs/自主决策记录.md AJ-76
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outboundHttpOptions, breakerPolicyOf } from './http-outbound.js';
import { loadConfig, type AppConfig } from '../config.js';
import { DEFAULT_RETRY_POLICY } from '../ports/http-client.js';
import { DEFAULT_BREAKER_POLICY, type BreakerPolicy } from '../ports/circuit-breaker.js';
import { DEFAULT_TIMEOUT_MS, DEFAULT_TOTAL_BUDGET_MS } from '../adapters/http/fetch-client.js';

/**
 * 最小可启动配置（与 config.unit.test.ts 的 `baseEnv` 同款）。
 * @why 刻意**不用 production**：生产有一整套跨字段规则（CORS / 密钥 / 非 localhost），
 *      用了会让失败来自别的规则，测不到"出站参数映射"这一件事。
 */
function cfg(over: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgresql://u@localhost:5432/japan_shop',
    JWT_SECRET: 'x'.repeat(32),
    PAYMENT_CHANNELS: 'mock',
    TERMS_VERSION: 'TOS-1',
    ...over,
  });
}

describe('出站 HTTP 参数来自配置（不是写死在实现里）', () => {
  it('默认配置产生的参数，与实现层的兜底常量**逐项相等**（同源断言）', () => {
    // @why 这是本单元最关键的一条。实现层留兜底是为了 `createFetchClient()` 单独可用，
    //      但"配置默认值"和"兜底常量"一旦不等，就会出现"改了配置不起作用"——
    //      而且**不会报错**，因为两条路径都能跑。这是典型的静默漂移。
    const o = outboundHttpOptions(cfg());
    expect(o.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(o.totalBudgetMs).toBe(DEFAULT_TOTAL_BUDGET_MS);
    expect(o.breakerPolicy).toEqual(DEFAULT_BREAKER_POLICY);
  });

  it('改配置，出站参数真的跟着改（证明接上了，而不是只加了字段）', () => {
    const o = outboundHttpOptions(
      cfg({
        HTTP_TIMEOUT_MS: '3000',
        HTTP_TOTAL_BUDGET_MS: '1500',
        CB_FAILURE_THRESHOLD: '9',
        CB_COOLDOWN_MS: '120000',
        CB_HALF_OPEN_PROBES: '2',
      }),
    );
    expect(o.timeoutMs).toBe(3000);
    expect(o.totalBudgetMs).toBe(1500);
    expect(o.breakerPolicy).toEqual({
      failureThreshold: 9,
      cooldownMs: 120_000,
      halfOpenMaxProbes: 2,
    });
  });

  it('总预算必须小于"单次超时 × 重试次数"（否则预算这道闸等于没设）', () => {
    // @why 这条不变量是 AJ-55 的全部意义：10s × 3 = 30s 会挂死同步链路。
    //      预算存在的理由就是**比那更短**。它不在 schema 里（依赖乘出来的量），
    //      所以只能在这里钉——否则有人把预算调大到 30s 就白设了。
    const c = cfg();
    expect(c.HTTP_TOTAL_BUDGET_MS).toBeLessThan(
      c.HTTP_TIMEOUT_MS * DEFAULT_RETRY_POLICY.maxAttempts,
    );
    expect(c.HTTP_TOTAL_BUDGET_MS).toBeLessThanOrEqual(c.HTTP_TIMEOUT_MS);
  });

  it('熔断阈值必须大于重试次数（否则一次请求就把上游判死，熔断与重试成了同一件事）', () => {
    // @why 这条写在 ports/circuit-breaker.ts 的 @why 里，但**注释不会报错**。
    //      阈值 ≤ 重试次数时，"一个请求打三次全失败"会直接跳闸，
    //      于是熔断保护的不是"上游挂了"而是"单次抖动"——保护方向就错了。
    const p: BreakerPolicy = breakerPolicyOf(cfg());
    expect(p.failureThreshold).toBeGreaterThan(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(DEFAULT_BREAKER_POLICY.failureThreshold).toBeGreaterThan(
      DEFAULT_RETRY_POLICY.maxAttempts,
    );
  });

  it('装配处真的调用了它（防"映射写好了，装配处忘了用"）', () => {
    // @why §2 第 35 条（AJ-74）已经踩过一次：**组件/封装做对了 ≠ 它被用上了**，
    //      而"没被用上"不会让任何一条用例红——实现层会静默回落到自己的兜底常量，
    //      于是配置形同虚设，且线上表现与"配好了"完全一样。
    //      这里不做语法解析，只断言装配处**确实引用了**它：
    //      @limitation 形式是源码字符串包含判断——改成 `createFetchClient({ logger })`
    //      这类写法会让它红，那正是想要的（那就是"忘了接"）。
    // ⚠️ I1-U1（AJ-103）：路由/通道装配从 main.ts 收敛到 `app/mount.ts`（唯一挂载清单），
    //    本断言的读取目标同步改为 mount.ts——main.ts 只剩"调 mountAllRoutes"的一行，
    //    通道装配（含 createFetchClient）全部在 mount.ts。
    const mount = readFileSync(resolve(import.meta.dirname, './mount.ts'), 'utf8');
    expect(mount).toContain('outboundHttpOptions(');
    expect(mount).toMatch(/createFetchClient\(\{[^}]*outboundHttpOptions\(config\)/);
  });

  it('不传任何覆盖时，产物里没有 undefined（防止"加了字段但忘了映射"）', () => {
    // @why `exactOptionalPropertyTypes` 下，多出一个 `undefined` 值的键会让实现层的
    //      `??` 兜底失效吗——不会（undefined 会走 ??），但它会让"这个值是配置给的还是兜底的"
    //      变得不可分辨。所以直接断言三个键都是数字。
    const o = outboundHttpOptions(cfg());
    expect(typeof o.timeoutMs).toBe('number');
    expect(typeof o.totalBudgetMs).toBe('number');
    expect(typeof o.breakerPolicy).toBe('object');
  });
});
