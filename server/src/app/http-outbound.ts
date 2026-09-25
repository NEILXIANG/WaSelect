/**
 * 职责：把配置的"出站 HTTP 三个数字"翻译成 `FetchClientOptions`（F12 遗留②）。
 *
 * @why 这三个数字（单次超时 / 总预算 / 熔断策略）原本**写死在实现里**，改一次要发版。
 *      但它们恰恰是最需要"上线后根据真实情况调"的那一类：
 *      - 单次超时与总预算是**产品决策**（用户能等多久），拿到真实的
 *        "等待时长 vs 放弃率"之后必然要调；
 *      - 熔断阈值与冷却要跟着上游的**真实故障形态**校准（现在的 5 / 30s 是拍的，见 AJ-61）。
 *      所以它们必须走配置：调整不发版，且改完有据可查。
 *
 * @why 单独抽一个文件而不是在 `main.ts` 里直接展开字面量：
 *      ① 它是**纯函数**，可以单测（"配置改了，出站参数真的跟着改"这件事必须被验过，
 *         否则"接了配置"和"没接"在运行时看起来一模一样）；
 *      ② `main.ts` 是装配层，装配层里出现具体数值会让"这个数字从哪来"变成考古题。
 *
 * @limitation 一：**只搬了这三个**。`RetryPolicy`（最多 3 次、200ms 起退避、抖动 20%）
 *              仍写死在 `ports/http-client.ts` 里——它是**协议级**策略而不是运营参数：
 *              "POST 无幂等键不重试"是正确性红线，不该被配置打开；
 *              "重试几次"改动的收益也远小于改错的风险。等真有调它的需求再说。
 * @limitation 二：实现层（`fetch-client` / `ports/circuit-breaker`）**仍留着兜底常量**，
 *              因为 `createFetchClient()` 不传参数时也要能用（测试就这么调）。
 *              两处数字的**一致性由同源断言守着**（@see 本文件的单测），不是靠人记。
 *
 * @see ../config.ts（数字的唯一来源）；../adapters/http/fetch-client.ts；
 *      docs/地基搭建清单.md F12；docs/自主决策记录.md AJ-76
 */
import type { FetchClientOptions } from '../adapters/http/fetch-client.js';
import type { BreakerPolicy } from '../ports/circuit-breaker.js';
import type { AppConfig } from '../config.js';

/** 熔断策略三件套。@why 单独导出是为了让"阈值必须大于重试次数"这条不变量可被单测钉住。 */
export function breakerPolicyOf(cfg: AppConfig): BreakerPolicy {
  return {
    failureThreshold: cfg.CB_FAILURE_THRESHOLD,
    cooldownMs: cfg.CB_COOLDOWN_MS,
    halfOpenMaxProbes: cfg.CB_HALF_OPEN_PROBES,
  };
}

/**
 * 配置 → 出站客户端参数。
 *
 * @why 只传这三个 + 熔断策略，**不含 `logger`**：logger 不是配置（它来自进程级装配），
 *      由 `main.ts` 在展开时另外给。混进来会让这个函数依赖一个非配置对象，测试就要造假 logger。
 */
export function outboundHttpOptions(cfg: AppConfig): FetchClientOptions {
  return {
    timeoutMs: cfg.HTTP_TIMEOUT_MS,
    totalBudgetMs: cfg.HTTP_TOTAL_BUDGET_MS,
    breakerPolicy: breakerPolicyOf(cfg),
  };
}
