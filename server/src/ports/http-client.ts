/**
 * 职责：**出站 HTTP 端口**（F11 需要它，F12 会把它填满）。
 *
 * @why 支付适配器必须调机构接口，但"怎么发 HTTP"是另一件事：
 *      超时、重试、退避、熔断、代理、连接池——这些是**横切关注点**，
 *      不该在每个 Provider 里各写一遍（各写一遍的结果是：stripe 有超时、wechat 没有，
 *      而"没有超时"在生产上表现为**请求永久挂起**，比报错难排查得多）。
 *      把出站调用收成一个接口，这些能力将来就能在一处加。
 *
 * @why 现在就立这个端口（而不是等 F12）：支付适配器是它的**第一个真实使用者**，
 *      有真实使用者的接口才是按需求长出来的；等到 F12 再凭空设计，
 *      很容易设计出一个"谁都不需要"的通用 HTTP 客户端。
 *
 * @limitation 一：**没有重试 / 退避 / 熔断**。当前只有超时（由实现保证）。
 *              支付类请求的重试必须与幂等键绑定，否则重试 = 重复扣款，
 *              所以"重试"不能作为一个无脑中间件加在这里——它是 F12 的正式议题。
 * @limitation 二：只支持 `GET` / `POST` 与字符串 body。
 *              文件上传（multipart）等形态等出现真实需求再加，不预先设计。
 * @limitation 三：**响应体是字符串**，不在此解析 JSON。
 *              解析失败要区分"上游返回了 HTML 错误页"与"JSON 字段缺失"，
 *              这两种的排障方向完全不同，所以留给调用方按上下文处理。
 *
 * @see adapters/http/fetch-client.ts（真实实现）；adapters/payment/stripe-checkout.ts
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** 请求头（按需给；鉴权头由调用方显式传入，不放隐式全局）。 */
  headers?: Readonly<Record<string, string>> | undefined;
  /** 请求体原文（调用方负责编码，如 Stripe 的 form-urlencoded）。 */
  body?: string | undefined;
  /** 单次超时（毫秒）；实现必须遵守，缺省由实现自定（见实现的 @limitation）。 */
  timeoutMs?: number | undefined;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpClient {
  /**
   * 发一次请求。
   * @throws 网络错误 / 超时由实现抛出（调用方决定重试还是失败）
   */
  send(req: HttpRequest): Promise<HttpResponse>;
}
