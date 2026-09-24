/**
 * 职责：回调事件的登记与去重（评审 D3 的回调侧）。
 *
 * @why 两件独立但都非做不可的事：
 *      ① **去重**：机构对同一个事件会投递多次（Stripe 在 3 天内重试、微信同样有重发机制）。
 *         靠订单状态间接推断"处理过没有"是可行的，但那只能覆盖"状态已变"的情形——
 *         "处理失败"与"从未收到"在日志里长得一模一样，出事后无法自证。
 *      ② **举证**：机构说"我发了回调"、我们说"没收到"这类争议，唯一的证据就是这张表。
 *         跨境支付里争议周期以月计，等到那时再补记录是补不出来的。
 *
 * @why 去重交给 **数据库唯一约束**（`UNIQUE (provider, event_id)`）而不是"先查再插"：
 *      后者两步之间有竞态——机构的两次投递很可能落在两个请求上并发执行，
 *      "查的时候还没有、插的时候撞唯一约束"会成为一类偶发的 500。
 *
 * @limitation 一：**只存 payload 的 sha256，不存原文**。
 *              回调原文含签名、金额、收件人信息，落库等于绕过 redact 与 APPI 红线。
 *              代价：无法事后复查原文内容——若真需要，走"按 event_id 回查机构后台"这条路。
 * @limitation 二：`result` 只在**处理结束后**写一次；进程在处理中途崩溃时，该行会停在
 *              `processed_at IS NULL`——这正是"待对账"的信号（003 建的部分索引就是给它用的）。
 *              本文件**不负责**重试或补处理：那属于每日对账任务（F13）。
 *
 * @see migrations/003_idempotency_and_identity.sql；docs/基座评审复核意见-2026-09-23.md（D3）；
 *      docs/自主决策记录.md AJ-32（回调早到宽限期，二审 N4）
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './adapters/db.js';

/**
 * 处理租约时长（毫秒，N22）：一次"登记 → 处理"的持有期。
 *
 * @why 10 秒而不是更小：回调处理是本地 DB 操作，正常在百毫秒级；
 *      租约要给"慢一点但仍然活着"的请求留余量——租约过短会把正常请求误判成崩溃遗留，
 *      于是第二个持有者接管，两个持有者同时处理（正是本租约要防的事）。
 * @why 也不是更大：租约到期前，同一事件的重复投递都会收到 503（让机构稍后重发）。
 *      真正的兜底是对账任务（F13），它不受这个时长影响——所以这里取"够用就好"。
 * @limitation 是**时长**不是心跳：持有者真卡死时要等满 10 秒才允许接管。
 */
export const DEFAULT_PROCESSING_LEASE_MS = 10_000;

/** 回调原文 → 64 位十六进制摘要（不落原文，见 @limitation 一）。 */
export function payloadHash(raw: Buffer | string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface WebhookEventInput {
  provider: string;
  /** 机构侧的事件 ID；同一事件重投时必须相同。 */
  eventId: string;
  eventType?: string | undefined;
  /** 原文摘要（用 {@link payloadHash} 算）。 */
  hash: string;
}

/**
 * 登记结果：**三态**，不是二态。
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
 * @why `retry` 只认 `processed_at IS NULL`（处理中途崩溃 / 宽限期内 503 主动不封口），
 *      不再有"按 result 值放行重试"的清单——AJ-32 之后，`order_not_found` 在宽限期内
 *      不封口（走 503 让机构重发），超过宽限期落 `unmatched:*` 是**终态**（转对账，不 retry），
 *      原来的 RETRYABLE_RESULTS 机制随之失去存在意义（N4 修复的一部分）。
 *
 * @why 四态是 N22 加的：三态把"**正在处理中**"和"**崩溃遗留**"压成了同一个 `retry`
 *      ——两者在库里长得一模一样（`processed_at IS NULL`）。后果是并发重复投递时
 *      两个请求都去处理同一事件：订单状态有行锁兜底不会错，但**事件行的 result 被后写完的覆盖**，
 *      "这条回调到底怎么处理的"就说不清了，而这张表存在的唯一理由就是举证。
 *      现在"处理中"由租约（`processing_until`）表达：租约未过期 = `inflight`（不许碰），
 *      过期了才叫 `retry`（可接管）。与幂等的栅栏令牌（N1）是同一套思路。
 */
export type ClaimState = 'new' | 'handled' | 'retry' | 'inflight';

export interface ClaimResult {
  state: ClaimState;
  /**
   * 本事件**首次**到达时间（宽限期计算的起点，DB 时钟）。
   * @why 用"我们首次收到的时间"而不是机构报文里的时间戳：后者依赖机构时钟，
   *      且骨架的模拟回调根本没有时间戳字段；前者单调、无时钟偏移问题。
   */
  firstReceivedAt: Date;
  /**
   * **DB 的当前时间**（`now()`），与 {@link firstReceivedAt} 同源。
   *
   * @why 宽限期要拿"现在"减"首次到达"，两个数必须来自**同一个时钟**。
   *      `firstReceivedAt` 是 Postgres 写的（`received_at` 默认 now()），
   *      若用应用的 `Date.now()` 去减它，就是跨时钟做减法：应用时钟快 20 分钟时，
   *      一条刚到的回调会被判成"超过 15 分钟宽限期" → 2xx 收下 + 落 unmatched、
   *      机构不再重发，"钱到单未付"就此静默且无任何报错（2026-09-23 自查发现）。
   *      Render 上应用与 Postgres 是不同实例，时钟差几秒很常见。
   * @limitation 极少数路径（见下方"查不到行"的兜底）拿不到 DB 时钟，
   *             此时退化为应用时钟——那条路径本就是理论不可达的保守兜底。
   */
  nowAt: Date;
  /**
   * 本次持有者的**栅栏令牌**（N22，与幂等的 lease_token 同源）。
   * 只有 `new` / `retry`（即"本次应当处理"）才有值；`handled` / `inflight` 为 undefined。
   *
   * @why 后续写结果必须携带它（`finishWebhookEvent`）：租约过期的旧持有者若还能按
   *      (provider,event_id) 写结果，就会覆盖**新持有者**的处理结果——
   *      举证表上留下的是"迟到者的说法"，这正是它要防的事。
   */
  token?: string | undefined;
}

export async function claimWebhookEvent(
  db: Db,
  input: WebhookEventInput,
  leaseMs: number = DEFAULT_PROCESSING_LEASE_MS,
): Promise<ClaimResult> {
  const token = randomUUID();
  const inserted = await db`
    insert into webhook_events
      (provider, event_id, event_type, payload_hash, processing_until, processing_token)
    values (${input.provider}, ${input.eventId}, ${input.eventType ?? null}, ${input.hash},
            now() + ${leaseMs} * interval '1 millisecond', ${token})
    on conflict (provider, event_id) do nothing
    returning received_at, now() as now_at
  `;
  if (inserted.length > 0) {
    return {
      state: 'new',
      firstReceivedAt: inserted[0]?.received_at as Date,
      nowAt: inserted[0]?.now_at as Date,
      token,
    };
  }

  /**
   * 冲突 → 先试接管"崩溃遗留"：未完成 **且** 租约已过期（或根本没有租约，005 之前的旧行）。
   * @why 用 UPDATE ... WHERE ... RETURNING 一次完成判断与占位（同幂等的 claim）：
   *      "先查再改"两步之间有竞态，两个等待者会同时判定"可以接管"然后都去处理。
   * @limitation 顺带覆盖了 005 之前的旧行（processing_until IS NULL）→ 视为可接管，
   *             否则那些行会永久卡在"未完成又没人能碰"的状态。
   */
  const taken = await db`
    update webhook_events
       set processing_until = now() + ${leaseMs} * interval '1 millisecond',
           processing_token = ${token}
     where provider = ${input.provider} and event_id = ${input.eventId}
       and processed_at is null
       and (processing_until is null or processing_until < now())
    returning received_at, now() as now_at
  `;
  if (taken.length > 0) {
    return {
      state: 'retry',
      firstReceivedAt: taken[0]?.received_at as Date,
      nowAt: taken[0]?.now_at as Date,
      token,
    };
  }

  // 抢不到：已处理完 → handled；否则一定有人在持有期内 → inflight
  const rows = await db`
    select processed_at, received_at, now() as now_at from webhook_events
     where provider = ${input.provider} and event_id = ${input.eventId}
  `;
  const row = rows[0];
  // 理论上不可能走到（刚插入或已存在）；保守当作首次、起点给当前时间（宽限期从零算起）
  if (row === undefined) {
    return { state: 'new', firstReceivedAt: new Date(), nowAt: new Date(), token };
  }
  return {
    state: row.processed_at === null ? 'inflight' : 'handled',
    firstReceivedAt: row.received_at as Date,
    nowAt: row.now_at as Date,
  };
}

/**
 * 标记处理结果。
 * @param result 短标识：`paid` / `paid:already` / `unmatched:order_not_found` /
 *        `ignored:status_conflict` / `failed`（宽限期内 503 的早到回调**不调用本函数**——
 *        processed_at 保持 NULL 是对账信号，见 AJ-32）
 */
export async function finishWebhookEvent(
  db: Db,
  input: WebhookEventInput & { result: string; note?: string | undefined; token: string },
): Promise<boolean> {
  const rows = await db`
    update webhook_events
       set processed_at = now(), result = ${input.result}, note = ${input.note ?? null},
           processing_until = null
     where provider = ${input.provider} and event_id = ${input.eventId}
       and processing_token = ${input.token}
    returning event_id
  `;
  /**
   * @returns false = 租约已易主（我们是**迟到的**旧持有者）：此时绝不能按
   *          (provider,event_id) 兜底重写——那覆盖的是新持有者的结果，
   *          举证表上留下的是"迟到者的说法"。业务已经处理完了，这里只回报"没写成"。
   * @limitation 不抛错：业务侧（订单已置 paid）已经生效，抛错会让机构以为失败并重发，
   *             反而把一次已成功的支付搅乱。真正的兜底是对账（F13）。
   */
  return rows.length > 0;
}

/**
 * **主动交还租约**：我这次不处理了，让下一次投递可以立刻接管。
 *
 * @why N22 加租约时漏了这一环（自己的 e2e 把它抓了出来）："回调比订单先到"会走
 *      `503 让机构重发`，而请求在那一刻就结束了——它**没有在等待**，租约却还挂在它名下 10 秒。
 *      于是接下来 10 秒内机构按 Retry-After 发来的重投，会被判成 `inflight` 再吃一个 503：
 *      "早到 → 重发 → 补上"这条链被租约自己掐断了，而"钱到单未付"正要靠它兜底。
 *      租约的语义是"**我正在处理**"，不是"我见过这条"——决定不处理就必须交还。
 * @why 交还的是 `processing_until / processing_token`，**不动 `processed_at`**：
 *      processed_at 仍为 NULL 才是"待办"信号（对账用），两者必须分开表达。
 *      结果已被 finish 写过的行（`processed_at NOT NULL`）不在交还范围内——见下面的 WHERE。
 *
 * @returns true = 交还成功；false = 令牌已失效（租约过期被别人接管了，或这行已经封口）。
 *          两种情况都**不需要**补偿：前者已有人在接管处理，后者本就是终态。
 * @limitation 与 {@link finishWebhookEvent} 一样带栅栏令牌，防止迟到的旧持有者
 *             把**新持有者**刚刚拿到的租约清掉（那会让新持有者失去写结果的资格）。
 */
export async function releaseWebhookLease(
  db: Db,
  input: WebhookEventInput & { token: string },
): Promise<boolean> {
  const rows = await db`
    update webhook_events
       set processing_until = null, processing_token = null
     where provider = ${input.provider} and event_id = ${input.eventId}
       and processing_token = ${input.token}
       and processed_at is null
    returning event_id
  `;
  return rows.length > 0;
}
