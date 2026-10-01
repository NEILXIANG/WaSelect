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
 * @limitation 一：**退避与熔断还没接进实现**（F12 进行中）。
 *              本文件已经给出**重试判定**（`shouldRetry`）与退避（`backoffMs`）两个纯函数，
 *              但"要不要重试"这件事不能做成一个无脑中间件：
 *              支付类请求的重试必须与幂等键绑定，否则重试 = **重复扣款**。
 *              所以判定规则写在这里（可测、可审），由实现显式调用，不做成隐式行为。
 * @limitation 二：只支持 `GET` / `POST` 与字符串 body。
 *              文件上传（multipart）等形态等出现真实需求再加，不预先设计。
 * @limitation 三：**响应体是字符串**，不在此解析 JSON。
 *              解析失败要区分"上游返回了 HTML 错误页"与"JSON 字段缺失"，
 *              这两种的排障方向完全不同，所以留给调用方按上下文处理。
 *
 * @see adapters/http/fetch-client.ts（真实实现）；adapters/payment/stripe-checkout.ts；
 *      docs/地基搭建清单.md F12
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
  /**
   * 5xx 时"要不要重试"的**上游建议头名**（小写；不给 = 5xx 一律不重试）。
   *
   * @why B4 / AJ-200：带幂等键的 POST 遇 5xx，重试**拿回的是同一个失败**——
   *      Stripe 会把失败结果按幂等键缓存（≥24h），重发只是白等，还要白白吃掉
   *      `totalBudgetMs`（6s）里的一段，把"用户能感知的等待"用在一个注定失败的动作上。
   *      @measured(github.com/stripe/stripe-node#network-retries, 2026-09-29)：官方库读
   *      `Stripe-Should-Retry` 响应头决定是否重试——**上游自己知道**这次故障是
   *      "可以再试"还是"重试也没用"。
   * @why 头名由**适配器声明**而不是写死在端口里：端口不认识任何机构（ADR-28）。
   *      不声明的一方得到的是"5xx 不重试"这个保守默认——宁可少试一次，
   *      也不要在一个按键缓存失败的机构上白等两轮。
   */
  retryAdviceHeader?: string | undefined;
  /**
   * 本次请求的**尝试次数上限**（缺省用客户端的策略）。给 `1` = **这个请求只发一次**。
   *
   * @why GET 被默认当作"天生幂等、随便重试"，但**幂等不等于无副作用**：
   *      微信 `jscode2session` 就是 GET，而它每次调用都会**消耗掉**那个 code
   *      （PAY3-07）。第一次请求其实已送达并被处理、只是响应在路上断了
   *      （`ECONNRESET` / socket hang up，undici 抛 `TypeError: fetch failed`），
   *      重试拿回的是 `errcode 40163`（code 已被使用），而我们把它映射成 40101
   *      ——**一次网络抖动被说成"用户侧的登录失败"**，排障方向整个反掉。
   *      "重试是否安全"只能由调用方回答：只有它知道这个动作是不是一次性的。
   * @why 做成"次数上限"而不是 `retry: false` 布尔：上限能与客户端策略组合
   *      （见实现的钳制规则），布尔则是一刀切，将来想"这个动作最多试 2 次"又要改形状。
   * @limitation 只能把上限**往下调**，不能往上调（实现会钳到客户端策略之内）：
   *      否则任何一个适配器都能悄悄越过全局策略，而全局策略是**产品级**的预算决定。
   */
  maxAttempts?: number | undefined;
}

export interface HttpResponse {
  status: number;
  body: string;
  /**
   * 响应头（**键一律小写**）。
   * @why 原来只读 status 与 body（旧 @limitation 三），于是"上游建议要不要重试"这类
   *      信息根本进不了判定——B4 必须为它开一个口子。
   * @limitation 只透传**字符串值**：多值头（Set-Cookie）会丢，本端口没有这个需求。
   */
  headers?: Readonly<Record<string, string>> | undefined;
}

export interface HttpClient {
  /**
   * 发一次请求。
   * @throws 网络错误 / 超时由实现抛出（调用方决定重试还是失败）
   */
  send(req: HttpRequest): Promise<HttpResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 重试判定（F12 第一单元）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 出站失败的分类——**只有分类之后才能回答"能不能重试"**。
 *
 * @why 不直接给 `boolean shouldRetry(status)`：
 *      "超时"与"连接被拒"在 HTTP 层长得完全不一样（一个是异常、一个可能是 5xx 响应），
 *      但它们要不要重试取决于**同一件事**：这次失败时，上游**有没有可能已经收到并处理了**。
 *      先把形态各异的失败收敛成这一类语义，判定规则才只有一份、才可测。
 */
export type HttpFailureKind =
  /** 没失败（2xx/3xx）。 */
  | 'none'
  /** 超时：请求**可能已经到达**上游，也可能没有——最危险的一类。 */
  | 'timeout'
  /** 网络层错误（DNS / 连接被拒 / 连接被重置）：同上，无法确认到达与否。 */
  | 'network'
  /** 5xx：上游自己说"我错了"。请求**大概率已被收到**。 */
  | 'server_error'
  /** 429：上游明确拒绝处理（不是失败，是"你慢点"）——请求**没有被处理**。 */
  | 'rate_limited'
  /** 4xx（非 429）：我们的请求本身有问题，重试一万次也不会变。 */
  | 'client_error'
  /** 认不出来。**保守当作"可能已到达"**（宁可不重试，也不能重复扣款）。 */
  | 'unknown';

export interface RetryPolicy {
  /** 总尝试次数（**含首次**）。1 = 不重试。 */
  maxAttempts: number;
  /** 第 1 次重试前的基准延迟（毫秒）。 */
  baseDelayMs: number;
  /** 延迟上限：指数退避不封顶会在上游长时间故障时把重试推到几分钟后。 */
  maxDelayMs: number;
  /** 抖动比例 0~1：0 = 完全不抖（测试与确定性场景）。 */
  jitterRatio: number;
}

/**
 * 默认策略：最多 2 次重试（共 3 次尝试），200ms 起、指数退避、封顶 2s、抖动 20%。
 *
 * @why 只重试 2 次而不是 5 次：出站调用在**用户等待的同步链路**上（下单 → 建支付会话），
 *      按 200/400ms 退避，3 次尝试最坏约 600ms + 单次超时 10s……⚠️ 这里有个真实的量级问题：
 *      **超时 10s × 3 次 = 30s**，远超用户能等的时间。
 *      所以实现层必须对"重试链"设一个**总预算**（F12 第二单元做），
 *      而不是让每次重试各自拿满 10s——本策略只负责"退避多久"，不负责总时长。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
};

/** 幂等键头名（**小写比较**：HTTP 头名大小写不敏感，调用方可能写 `Idempotency-Key`）。 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** 按 HTTP 状态码分类。非 2xx 才算失败。 */
export function httpStatusKind(status: number): HttpFailureKind {
  if (status >= 200 && status < 400) return 'none';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  // 1xx / 3xx 里不该出现在最终响应上；认不出来就当未知，保守处理
  return 'unknown';
}

/**
 * 按**异常**分类（实现层抛出来的东西）。
 *
 * @limitation 依赖异常的形状（`name` / `code`）而不是类型：
 *      `fetch` 的超时是 `DOMException('TimeoutError')`、网络错误是 `TypeError: fetch failed`，
 *      不同 Node 版本与不同实现给出的对象不完全一样。
 *      认不出来时返回 `'unknown'`（**保守**：按"可能已到达"处理，即要求幂等键才重试）。
 */
export function classifyHttpFailure(err: unknown): HttpFailureKind {
  if (err === null || typeof err !== 'object') return 'unknown';
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
    return 'timeout';
  }
  if (e.name === 'TypeError' || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
    return 'network';
  }
  return 'unknown';
}

/**
 * 第 `attempt` 次失败后应等多久（毫秒）：`base * 2^(attempt-1)`，封顶 `maxDelayMs`，再抖。
 *
 * @param rand 随机源（**注入**）。默认 `() => 0`（不抖）——见下面 @why。
 * @why 抖动要**注入**而不是在函数里调 `Math.random()`：本文件在 `ports/`，
 *      而纯度门禁禁止业务侧直连全局随机源（AJ-50）。适配器层是豁免的，由它传 `Math.random`。
 *      默认不抖的额外好处是：忘了传也不会出错，只是没有抖动（惊群风险，不是正确性错误）。
 * @why 抖动取 `[0, jitterRatio * base]` 而不是常见的 `[base/2, base]`：
 *      后者会把延迟整体抬高（首次重试等待变长），而我们重试的是**用户正在等**的同步链路，
 *      宁可抖动幅度小一点，也不要让 P50 变慢。
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  rand: () => number = () => 0,
): number {
  if (attempt < 1) return 0;
  const raw = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const r = rand();
  // rand() 可能返回负值（替身写错时）；钳到 [0,1]，别让抖动把延迟减成负数
  const jitter = raw * policy.jitterRatio * Math.min(Math.max(r, 0), 1);
  return Math.round(raw + jitter);
}

export interface RetryDecision {
  retry: boolean;
  /** 建议等待毫秒数（`retry === false` 时为 0）。 */
  delayMs: number;
  /** 不重试的**原因**（进日志：线上"为什么没重试"必须能回答）。 */
  reason: string;
}

/** 请求里有没有幂等键（头名大小写不敏感）。 */
function hasIdempotencyKey(req: HttpRequest): boolean {
  if (req.headers === undefined) return false;
  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === IDEMPOTENCY_HEADER) return true;
  }
  return false;
}

/**
 * 该不该重试——**F12 里唯一一条不能写错的规则**。
 *
 * @param attempt **已经完成的尝试次数**（首次失败时为 1）。
 * @param res 失败的**响应**（5xx 判"上游建议"要读它的头；超时/网络错误没有响应，不传）。
 */
export function shouldRetry(
  req: HttpRequest,
  failure: HttpFailureKind,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = () => 0,
  res?: HttpResponse | undefined,
): RetryDecision {
  const stop = (reason: string): RetryDecision => ({ retry: false, delayMs: 0, reason });
  if (failure === 'none') return stop('未失败');
  if (failure === 'client_error') return stop('4xx：请求本身有问题，重试不会变');
  /**
   * 声明只发一次的请求（PAY3-07）：**在任何失败分类上都停下来**，包括 429。
   * @why 单独给一条 reason：走下面"尝试次数用尽（1/1）"也能停，但日志里看不出
   *      这是"调用方声明的一次性动作"还是"真的试满了"。排障时这两种的含义相反——
   *      前者是**设计如此**，后者是"上游一直坏"。
   */
  if (policy.maxAttempts <= 1) return stop('本请求声明只发一次（一次性动作，重试不安全）');
  if (attempt >= policy.maxAttempts)
    return stop(`尝试次数用尽（${attempt}/${policy.maxAttempts}）`);

  /**
   * 🔒 POST 无幂等键 → **一律不重试**（`rate_limited` 除外）。
   *
   * @why 重试只在"上游**确定没有**处理过"时才安全。超时 / 5xx / 网络错误都意味着
   *      "我们不知道它处理了没有"——对一个**会扣款**的 POST 再发一次，
   *      就是**重复扣款**。带幂等键时上游按同一个键返回第一次的结果，才安全。
   *      这条规则写成"要求幂等键"而不是"禁止重试 POST"：前者让正确的用法走得通，
   *      后者会逼着人在真实需要重试时绕过它。
   * @why 429 例外：上游明确**没有处理**这个请求（它只是让你慢点），所以重试安全。
   * @why 排在 5xx 那条**之前**："没带幂等键"是更严重的错（可能重复扣款），
   *      日志里的 reason 必须说这一条，不能被"上游没建议重试"盖掉。
   */
  if (req.method === 'POST' && failure !== 'rate_limited' && !hasIdempotencyKey(req)) {
    return stop('POST 缺少幂等键：重试可能重复扣款');
  }

  /**
   * 🔒 5xx：**只有上游明确建议重试**才重试（B4 / AJ-200）。
   *
   * @why 对带幂等键的请求，重发 5xx 拿回的是**缓存的同一次失败**，不是"再试一次"；
   *      真正该做的是把剩下的时间预算还给调用方（让它换通道 / 报错），而不是在这里空转。
   * @why 判据放在端口而不是各适配器：`shouldRetry` 是"哪些失败可以重试"的唯一真源，
   *      各适配器自己判就会长出 N 份口径（F12 第一单元立这条规则就是为了只有一份）。
   * @tradeoff 对"上游瞬时过载"这类**真的**会好的 5xx，不重试等于放弃了最后一次机会；
   *           但那种场景上游本来就该回 `Stripe-Should-Retry: true`（或 429 + Retry-After），
   *           我们按它说的做。代价由"少试一次"承担，不由"白等两轮"承担。
   * @limitation 没声明 `retryAdviceHeader` 的请求一律不重试 5xx——保守默认。
   */
  if (failure === 'server_error') {
    const header = req.retryAdviceHeader;
    if (header === undefined || header.length === 0) {
      return stop('5xx：本请求没声明上游建议头，按保守默认不重试（B4/AJ-200）');
    }
    const advised = res?.headers?.[header];
    if (advised !== 'true') {
      return stop(`5xx：上游建议头 ${header}=${String(advised)}（非 true）`);
    }
  }

  return { retry: true, delayMs: backoffMs(attempt, policy, rand), reason: `${failure} 可重试` };
}
