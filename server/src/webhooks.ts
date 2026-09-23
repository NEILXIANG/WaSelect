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
 * @see migrations/003_idempotency_and_identity.sql；docs/基座评审复核意见-2026-09-23.md（D3）
 */
import { createHash } from 'node:crypto';
import type { Db } from './db.js';

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
 * - `retry`：登记过但**上次没处理成功**，应当再处理一次
 *
 * @why 二态（"见过 = 重复"）会吞掉一类真实场景：**回调比订单先到**。
 *      机构在下单事务提交前就把回调打过来（或我们这侧延迟可见），首轮处理得到
 *      `order_not_found`；随后机构重发**同一个** event_id，此时订单已存在、本该成功——
 *      若按"见过就算重复"直接返回，这张单就永远不会被标记为已支付。
 *      "钱到了但订单没变成 paid"是最贵的一类事故，而去重只是性能优化，
 *      两者冲突时**必须让位给正确性**。
 * @why `retry` 也覆盖"上次处理到一半进程崩了"（`processed_at IS NULL`）的情形——
 *      那一行本来就是留给对账任务的信号，顺手在这里变成"可以重试"是自洽的。
 */
export type ClaimState = 'new' | 'handled' | 'retry';

/** 上次结果是"订单不存在"时允许重试：见 {@link ClaimState} 的 @why。 */
const RETRYABLE_RESULTS = ['ignored:order_not_found'];

export async function claimWebhookEvent(db: Db, input: WebhookEventInput): Promise<ClaimState> {
  const inserted = await db`
    insert into webhook_events (provider, event_id, event_type, payload_hash)
    values (${input.provider}, ${input.eventId}, ${input.eventType ?? null}, ${input.hash})
    on conflict (provider, event_id) do nothing
    returning id
  `;
  if (inserted.length > 0) return 'new';

  const rows = await db`
    select processed_at, result from webhook_events
     where provider = ${input.provider} and event_id = ${input.eventId}
  `;
  const row = rows[0];
  if (row === undefined) return 'new'; // 理论上不可能（刚插入或已存在），保守当作首次
  if (row.processed_at === null) return 'retry';
  return RETRYABLE_RESULTS.includes(String(row.result)) ? 'retry' : 'handled';
}

/**
 * 标记处理结果。
 * @param result 短标识：`paid` / `ignored:order_not_found` / `ignored:status_conflict` / `failed`
 */
export async function finishWebhookEvent(
  db: Db,
  input: WebhookEventInput & { result: string; note?: string | undefined },
): Promise<void> {
  await db`
    update webhook_events
       set processed_at = now(), result = ${input.result}, note = ${input.note ?? null}
     where provider = ${input.provider} and event_id = ${input.eventId}
  `;
}
