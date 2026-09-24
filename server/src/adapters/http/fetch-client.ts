/**
 * 职责：出站 HTTP 的**真实实现**（`fetch`）——`ports/http-client.ts` 的第一个实现。
 *
 * @why 用平台自带的 `fetch` 而不是 axios / got：本项目只有一个出站调用方（支付机构），
 *      多一个依赖换来的是"又一个要升版本、要审 CVE 的东西"，
 *      而 `fetch` 在 Node 22 上已经是稳定实现。等 F12 要加熔断/连接池时再评估。
 *
 * @limitation 一：**必须自带超时**。`fetch` 默认没有超时，
 *      上游不响应时请求会一直挂着——在支付链路上这表现为"用户点了付款、页面转圈到天亮"，
 *      而且连接池会被占满。所以这里强制默认 10 秒（可用 `timeoutMs` 覆盖）。
 * @limitation 二：**不重试**（见端口 @limitation 一：支付重试必须绑幂等键，不能无脑加）。
 * @limitation 三：不读响应头、不做流式处理。当前只需要 `status` 与 `body`；
 *              需要响应头的场景（如机构的 `request-id`）出现时再扩展接口，不预先加。
 * @limitation 四：4xx/5xx **不算异常**。是否失败由调用方按语义判断——
 *              "上游返回 402 卡被拒"与"上游 500"的处理方式完全不同，
 *              在这里统一抛异常会抹掉这个区别。
 *
 * @see ../../ports/http-client.ts（端口契约与"为什么现在就立这个端口"）；
 *      docs/地基搭建清单.md F11（第一个使用者）、F12（外部调用封装将在此补重试/熔断）
 */
import type { HttpClient, HttpRequest, HttpResponse } from '../../ports/http-client.js';

/** 默认超时：支付链路不能无限等（见 @limitation 一）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

export function createFetchClient(opts: { timeoutMs?: number } = {}): HttpClient {
  const fallbackTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async send(req: HttpRequest): Promise<HttpResponse> {
      const init: RequestInit = {
        method: req.method,
        ...(req.headers !== undefined ? { headers: { ...req.headers } } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        // Node 22 支持 AbortSignal.timeout；超时后 fetch 抛 TimeoutError
        signal: AbortSignal.timeout(req.timeoutMs ?? fallbackTimeout),
      };
      const res = await fetch(req.url, init);
      return { status: res.status, body: await res.text() };
    },
  };
}
