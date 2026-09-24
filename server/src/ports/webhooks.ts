/**
 * 职责：回调事件登记的**端口**（F10）——业务层只认这个接口，不认 SQL、不认 postgres。
 *
 * @why 两件独立但都非做不可的事：
 *      ① **去重**：机构对同一个事件会投递多次（Stripe 在 3 天内重试、微信同样有重发机制）。
 *         靠订单状态间接推断"处理过没有"是可行的，但那只能覆盖"状态已变"的情形——
 *         "处理失败"与"从未收到"在日志里长得一模一样，出事后无法自证。
 *      ② **举证**：机构说"我发了回调"、我们说"没收到"这类争议，唯一的证据就是这张表。
 *         跨境支付里争议周期以月计，等到那时再补记录是补不出来的。
 *
 * @why 这里只放**契约**（类型 + 接口），实现在 `adapters/webhooks.ts`。
 *      业务代码（以及将来的 domain）依赖本文件，就永远不会碰到 SQL——
 *      换存储（比如把事件挪到另一张表 / 另一个库）时改适配器一处即可。
 *      反过来若业务直接 import 适配器，F10 的分层就名存实亡：
 *      改一次存储要动业务代码，而"改业务"正是最容易引入回归的地方。
 *
 * @limitation 一：**只存 payload 的 sha256，不存原文**。
 *              回调原文含签名、金额、收件人信息，落库等于绕过 redact 与 APPI 红线。
 *              代价：无法事后复查原文内容——若真需要，走"按 event_id 回查机构后台"这条路。
 * @limitation 二：`result` 只在**处理结束后**写一次；进程在处理中途崩溃时，该行会停在
 *              `processed_at IS NULL`——这正是"待对账"的信号（003 建的部分索引就是给它用的）。
 *              本接口**不负责**重试或补处理：那属于每日对账任务（F13）。
 *
 * @see migrations/003_idempotency_and_identity.sql；migrations/005_webhook_processing_lease.sql；
 *      docs/基座评审复核意见-2026-09-23.md（D3）；docs/自主决策记录.md AJ-32（回调早到宽限期，二审 N4）
 */

/**
 * 处理租约时长（毫秒，N22）：一次"登记 → 处理"的持有期。
 *
 * @why 放在**端口**而不是实现里：它是契约的一部分——调用方需要知道
 *      "租约期内同一个事件的重复投递会被拒（503）"，才能理解 `inflight` 这一态。
 * @why 10 秒而不是更小：回调处理是本地 DB 操作，正常在百毫秒级；
 *      租约要给"慢一点但仍然活着"的请求留余量——租约过短会把正常请求误判成崩溃遗留，
 *      于是第二个持有者接管，两个持有者同时处理（正是本租约要防的事）。
 * @why 也不是更大：租约到期前，同一事件的重复投递都会收到 503（让机构稍后重发）。
 *      真正的兜底是对账任务（F13），它不受这个时长影响——所以这里取"够用就好"。
 * @limitation 是**时长**不是心跳：持有者真卡死时要等满 10 秒才允许接管。
 */
export const DEFAULT_PROCESSING_LEASE_MS = 10_000;

export interface WebhookEventInput {
  provider: string;
  /** 机构侧的事件 ID；同一事件重投时必须相同。 */
  eventId: string;
  eventType?: string | undefined;
  /** 原文摘要（用适配器的 `payloadHash` 算）。 */
  hash: string;
}

/**
 * 登记结果：**四态**，不是二态也不是三态。
 *
 * - `new`：首次收到，应当处理
 * - `handled`：已经处理过（成功或被明确忽略），重复投递 → 直接 2xx 返回，不再处理
 * - `retry`：登记过、**上次没处理完且租约已过期**（崩溃遗留），应当接管并再处理一次
 * - `inflight`：**别人正在处理**（登记过、没处理完、租约未过期）——本次**不许**处理
 *
 * @why 二态（"见过 = 重复"）会吞掉一类真实场景：**回调比订单先到**。
 *      机构在下单事务提交前就把回调打过来（或我们这侧延迟可见），首轮处理得到
 *      `order_not_found`；随后机构重发**同一个** event_id，此时订单已存在、本该成功——
 *      若按"见过就算重复"直接返回，这张单就永远不会被标记为已支付。
 *      "钱到了但订单没变成 paid"是最贵的一类事故，而去重只是性能优化，
 *      两者冲突时**必须让位给正确性**。
 * @why 四态是 N22 加的：三态把"**正在处理中**"和"**崩溃遗留**"压成了同一个 `retry`
 *      ——两者在库里长得一模一样（`processed_at IS NULL`）。后果是并发重复投递时
 *      两个请求都去处理同一事件：订单状态有行锁兜底不会错，但**事件行的 result 被后写完的覆盖**，
 *      "这条回调到底怎么处理的"就说不清了，而这张表存在的唯一理由就是举证。
 *      现在"处理中"由租约表达：租约未过期 = `inflight`（不许碰），过期了才叫 `retry`。
 */
export type ClaimState = 'new' | 'handled' | 'retry' | 'inflight';

export interface ClaimResult {
  state: ClaimState;
  /**
   * 本事件**首次**到达时间（宽限期计算的起点，**DB 时钟**）。
   * @why 用"我们首次收到的时间"而不是机构报文里的时间戳：后者依赖机构时钟，
   *      且骨架的模拟回调根本没有时间戳字段；前者单调、无时钟偏移问题。
   */
  firstReceivedAt: Date;
  /**
   * **DB 的当前时间**（`now()`），与 {@link firstReceivedAt} 同源。
   *
   * @why 宽限期要拿"现在"减"首次到达"，两个数必须来自**同一个时钟**。
   *      若调用方改用应用的 `Date.now()` 去减它，就是跨时钟做减法：应用时钟快 20 分钟时，
   *      一条刚到的回调会被判成"超过 15 分钟宽限期" → 2xx 收下 + 落 unmatched、
   *      机构不再重发，"钱到单未付"就此静默且无任何报错（2026-09-23 自查发现）。
   *      Render 上应用与 Postgres 是不同实例，时钟差几秒很常见。
   */
  nowAt: Date;
  /**
   * 本次持有者的**栅栏令牌**（N22，与幂等的 lease_token 同源）。
   * 只有 `new` / `retry`（即"本次应当处理"）才有值；`handled` / `inflight` 为 undefined。
   *
   * @why 后续写结果必须携带它：租约过期的旧持有者若还能按 (provider,event_id) 写结果，
   *      就会覆盖**新持有者**的处理结果——举证表上留下的是"迟到者的说法"。
   */
  token?: string | undefined;
}

/**
 * 回调事件存储端口。实现见 `adapters/webhooks.ts` 的 `createWebhookStore`。
 *
 * @why 方法刻意保持**少而粗**：每个方法都对应"一次不可分割的数据库动作"
 *      （登记 / 封口 / 交还租约）。细到"先查后插"的粒度会把并发判断推给调用方，
 *      而调用方没有事务上下文，做不对——这正是去重必须靠数据库唯一约束的原因（@see 文件头）。
 */
export interface WebhookStore {
  /**
   * 登记一次投递并返回本次应当采取的行动。
   * @param leaseMs 处理租约时长，省略则用 {@link DEFAULT_PROCESSING_LEASE_MS}。
   */
  claim(input: WebhookEventInput, leaseMs?: number): Promise<ClaimResult>;

  /**
   * 标记处理结果（封口：写 `processed_at` 与 `result`，并交还租约）。
   * @param result 短标识：`paid` / `paid:already` / `unmatched:order_not_found` /
   *        `ignored:status_conflict` / `failed`（宽限期内 503 的早到回调**不调用本方法**——
   *        processed_at 保持 NULL 是对账信号，见 AJ-32）
   * @returns false = 租约已易主（我们是**迟到的**旧持有者）。业务既已生效，
   *          这里只回报"没写成"，绝不兜底重写——那覆盖的是新持有者的结果。
   */
  finish(
    input: WebhookEventInput & { result: string; note?: string | undefined; token: string },
  ): Promise<boolean>;

  /**
   * **主动交还租约**：我这次不处理了，让下一次投递可以立刻接管。
   *
   * @why N22 加租约时漏了这一环（被自己的 e2e 抓出来）："回调比订单先到"会走
   *      `503 让机构重发`，而请求在那一刻就结束了——它没有在等待，租约却还挂在它名下 10 秒。
   *      于是接下来 10 秒内机构按 Retry-After 发来的重投会被判成 `inflight` 再吃一个 503：
   *      "早到 → 重发 → 补上"这条链被租约自己掐断了，而"钱到单未付"正要靠它兜底。
   *      租约的语义是"**我正在处理**"，不是"我见过这条"——决定不处理就必须交还。
   * @returns true = 交还成功；false = 令牌已失效（租约过期被别人接管，或这行已经封口）。
   *          两种情况都**不需要**补偿：前者已有人在接管处理，后者本就是终态。
   */
  releaseLease(input: WebhookEventInput & { token: string }): Promise<boolean>;
}
