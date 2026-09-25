/**
 * 职责：出站 HTTP 的**真实实现**（`fetch`）——`ports/http-client.ts` 的第一个实现。
 *
 * @why 用平台自带的 `fetch` 而不是 axios / got：本项目只有一个出站调用方（支付机构），
 *      多一个依赖换来的是"又一个要升版本、要审 CVE 的东西"，
 *      而 `fetch` 在 Node 22 上已经是稳定实现。等要加熔断/连接池时再评估。
 *
 * @limitation 一：**必须自带超时**。`fetch` 默认没有超时，
 *      上游不响应时请求会一直挂着——在支付链路上这表现为"用户点了付款、页面转圈到天亮"，
 *      而且连接池会被占满。所以这里强制默认 10 秒（可用 `timeoutMs` 覆盖）。
 * @limitation 二：**重试只在策略允许时发生**，判定规则全在 `ports/http-client.ts`
 *      （POST 无幂等键 → 绝不重试）。本文件只负责"照判定去做"，不自己发明规则。
 *      ⚠️ 因此"重试几次"不是本文件的知识：改规则改端口，别在这里加条件。
 * @limitation 三：不读响应头、不做流式处理。当前只需要 `status` 与 `body`；
 *              需要响应头的场景（如机构的 `request-id`）出现时再扩展接口，不预先加。
 * @limitation 四：4xx/5xx **不算异常**。是否失败由调用方按语义判断——
 *              "上游返回 402 卡被拒"与"上游 500"的处理方式完全不同，
 *              在这里统一抛异常会抹掉这个区别。
 *              ⚠️ 但"重试次数用尽后的最后一个响应"仍会原样返回给调用方（不是抛异常），
 *              理由同上：那是上游的真实答复。
 * @limitation 五：熔断**默认开启、可注入、可显式关闭**。状态在**进程内存**里，
 *              重启即复位（多实例各跳各的）。详见 `./circuit-breaker.ts` 的 `@limitation`。
 *              ⚠️ 被熔断拒绝时抛 `CircuitOpenError`——它与"上游报错"是两类事，
 *              调用方要能分开处理；**本层不做错误码映射**（映射属 app 层，见 @limitation 六）。
 * @limitation 六：**不把 `CircuitOpenError` 翻译成业务错误码**。
 *              分层约束是 `app → domain → ports ← adapters`，adapters 不能反向 import app 的错误定义。
 *              所以当下它会以"未分类异常"冒到最外层，表现为 500 而不是"上游暂不可用"。
 *              这是已知缺口，要在 `app/pay-routes.ts` 的错误映射里补（登记在清单 F12 待办）。
 *
 * @see ../../ports/http-client.ts（端口契约、重试判定规则）；
 *      ./circuit-breaker.ts（熔断状态机与存放）；docs/地基搭建清单.md F12
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  RetryPolicy,
} from '../../ports/http-client.js';
import {
  classifyHttpFailure,
  DEFAULT_RETRY_POLICY,
  httpStatusKind,
  shouldRetry,
} from '../../ports/http-client.js';
import { breakerKey } from '../../ports/circuit-breaker.js';
import { CircuitOpenError, createCircuitBreaker, type CircuitBreaker } from './circuit-breaker.js';
import type { Logger } from '../../logger.js';

/** 默认超时：支付链路不能无限等（见 @limitation 一）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * **总时长预算**（所有尝试加起来），默认 6 秒。
 *
 * @why 必须单独设这个上限，而不是让每次重试各自拿满 `timeoutMs`：
 *      单次 10s × 3 次 = 30s，而出站调用发生在**用户正在等的同步链路**上
 *      （下单 → 建支付会话）。30 秒后即便成功，用户也早就不在了，
 *      更糟的是它占着一个请求槽位 30 秒，会把整个服务的并发吃掉。
 *      所以"退避多久"由策略管、**"总共能花多久"由这里管**，两者是两件事。
 * @why 6 秒而不是 3 秒：给"第一次超时 + 一次重试"留出空间（10s 会被预算截到 6s，
 *      即第一次最多用 6s；若第一次 1s 就失败，还剩 5s 给重试）。
 *      这个数字是**产品决策**（用户能等多久），不是技术常数，写在配置里可覆盖。
 */
export const DEFAULT_TOTAL_BUDGET_MS = 6_000;

export interface FetchClientOptions {
  timeoutMs?: number;
  /** 重试策略；不传用 `DEFAULT_RETRY_POLICY`。想**完全不重试**传 `{ maxAttempts: 1, … }`。 */
  retry?: RetryPolicy;
  /** 总时长预算（毫秒）。@see DEFAULT_TOTAL_BUDGET_MS 的 @why */
  totalBudgetMs?: number;
  /** 计时日志出口；不传则不记（脱敏由 logger 统一做）。 */
  logger?: Logger;
  /** 抖动随机源（测试注入固定值）。默认 `Math.random`。 */
  rand?: () => number;
  /** 退避等待（测试注入以跳过真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 计时源（测试注入以断言"预算真的被算进去了"）。 */
  now?: () => number;
  /**
   * 熔断器。
   *
   * @why **默认开启**（用默认策略 + 本客户端的 `logger` 与 `now`）：
   *      忘了配熔断的后果是"静默地没有保护"——门是绿的、链路是裸的，
   *      而"多了一层保护"的后果最坏是误判（可关、可调）。两个方向不对称，所以默认开。
   * @why 传 `null` 才是关闭：用一个**显式的空**表达"我知道并且不要"，
   *      比"不传就没有"更不容易发生在"我只是没想起来"的情况下。
   */
  breaker?: CircuitBreaker | null;
}

/** 把 URL 收敛成可安全入日志的形态：去查询串（里面可能有 token / 签名）。 */
function safeUrl(url: string): string {
  const at = url.indexOf('?');
  return at < 0 ? url : url.slice(0, at);
}

export function createFetchClient(opts: FetchClientOptions = {}): HttpClient {
  const fallbackTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy = opts.retry ?? DEFAULT_RETRY_POLICY;
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const logger = opts.logger;
  const rand = opts.rand ?? Math.random;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // ⚠️ 默认熔断**共用本客户端的时钟**：两处时间必须是同一个来源，
  //    否则测试里注入了假时钟却只有预算走假时间、冷却走真实时间——
  //    那种"一半可控"的状态最难排查。
  const breaker =
    opts.breaker === null ? undefined : (opts.breaker ?? createCircuitBreaker({ now, logger }));

  async function once(req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    const init: RequestInit = {
      method: req.method,
      ...(req.headers !== undefined ? { headers: { ...req.headers } } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      // Node 22 支持 AbortSignal.timeout；超时后 fetch 抛 TimeoutError
      signal: AbortSignal.timeout(timeoutMs),
    };
    const res = await fetch(req.url, init);
    return { status: res.status, body: await res.text() };
  }

  return {
    async send(req: HttpRequest): Promise<HttpResponse> {
      const startedAt = now();
      const key = breakerKey(req.url);

      // 出发前：熔断说"别打"就不打。
      // ⚠️ 这里**不发请求**，所以单独记一个 `http_outbound_circuit_open` 事件，
      //    而不是混进 `http_outbound`——后者会被当成"我们打了一次上游"来统计，
      //    而实际上一次网络往返都没发生（混进去会让"上游超时率"这类指标失准）。
      if (breaker !== undefined) {
        const gate = breaker.before(key);
        if (!gate.allowed) {
          logger?.error('http_outbound_circuit_open', {
            result: 'circuit_open',
            ctx: {
              url: safeUrl(req.url),
              method: req.method,
              key,
              state: gate.state,
              retry_after_ms: gate.retryAfterMs,
            },
          });
          throw new CircuitOpenError(key, gate.retryAfterMs);
        }
      }

      let attempt = 0;
      /**
       * 上一次尝试的结果。
       * @why 必须把"响应"与"异常"都留着：预算用尽时，若最后一次是**拿到了响应**，
       *      那个响应就是上游的真实答复，交出去比抛一个凭空的错误更接近事实
       *      （而且 5xx 与"卡被拒"对调用方是两种处理，抛异常会把它们抹平）。
       */
      let last:
        { kind: 'response'; res: HttpResponse } | { kind: 'error'; err: unknown } | undefined;

      for (;;) {
        attempt += 1;
        const remaining = totalBudgetMs - (now() - startedAt);
        // ⚠️ 剩余预算可能为 0/负：此时不能"再试一次但立刻超时"，
        //    那会白跑一趟网络并把超时噪声混进日志。预算用完就交出上一次的结果。
        if (remaining <= 0) break;
        const timeoutMs = Math.min(req.timeoutMs ?? fallbackTimeout, remaining);

        try {
          const res = await once(req, timeoutMs);
          last = { kind: 'response', res };
          const kind = httpStatusKind(res.status);
          // ⚠️ **每一次尝试**都喂给熔断（不是"整个请求结束后喂一次"）：
          //    重试了 3 次才成功，中间那两次失败是真实发生的，不该被最后一次的成功抹掉；
          //    而 `circuitAfter` 的语义是"成功即复位"，所以成功会自然清掉连续计数。
          breaker?.after(key, kind);
          if (kind === 'none') {
            logger?.info('http_outbound', {
              result: 'ok',
              duration_ms: now() - startedAt,
              ctx: { url: safeUrl(req.url), method: req.method, status: res.status, attempt },
            });
            return res;
          }
          const decision = shouldRetry(req, kind, attempt, policy, rand);
          if (!decision.retry) {
            logger?.warn('http_outbound', {
              result: kind === 'client_error' ? 'client_error' : 'server_error',
              duration_ms: now() - startedAt,
              ctx: {
                url: safeUrl(req.url),
                status: res.status,
                attempt,
                no_retry_reason: decision.reason,
              },
            });
            return res;
          }
          logger?.warn('http_outbound_retry', {
            result: 'retry_scheduled',
            ctx: {
              url: safeUrl(req.url),
              status: res.status,
              attempt,
              delay_ms: decision.delayMs,
            },
          });
          await sleep(decision.delayMs);
          continue;
        } catch (e) {
          last = { kind: 'error', err: e };
          const kind = classifyHttpFailure(e);
          breaker?.after(key, kind);
          const decision = shouldRetry(req, kind, attempt, policy, rand);
          if (!decision.retry) {
            logger?.error('http_outbound', {
              result: kind,
              duration_ms: now() - startedAt,
              err: e,
              ctx: { url: safeUrl(req.url), method: req.method, attempt, reason: decision.reason },
            });
            throw e;
          }
          logger?.warn('http_outbound_retry', {
            result: 'retry_scheduled',
            ctx: { url: safeUrl(req.url), attempt, delay_ms: decision.delayMs, kind },
          });
          await sleep(decision.delayMs);
        }
      }

      // 走到这里 = **预算用尽**（不是"判定不重试"——那两种已在循环内 return / throw）
      logger?.error('http_outbound', {
        result: 'budget_exhausted',
        duration_ms: now() - startedAt,
        ...(last?.kind === 'error' ? { err: last.err } : {}),
        ctx: {
          url: safeUrl(req.url),
          method: req.method,
          attempts: attempt,
          budget_ms: totalBudgetMs,
          last_status: last?.kind === 'response' ? last.res.status : undefined,
        },
      });
      if (last?.kind === 'response') return last.res;
      throw last?.err ?? new Error(`出站请求预算用尽：${safeUrl(req.url)}`);
    },
  };
}
