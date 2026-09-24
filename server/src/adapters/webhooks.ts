/**
 * 职责：回调事件存储的 **Postgres 适配器**（F10）——实现 `ports/webhooks.ts` 的 `WebhookStore`。
 *
 * @why 所有 SQL 只存在于本文件。业务侧（以及将来的 domain）只认端口接口，
 *      于是"换存储 / 改表结构 / 加字段"都不会波及业务判断——
 *      那正是 F10 分层想要的结果，而不是"目录分了但依赖没变"。
 *
 * @why 去重交给 **数据库唯一约束**（`UNIQUE (provider, event_id)`）而不是"先查再插"：
 *      后者两步之间有竞态——机构的两次投递很可能落在两个请求上并发执行，
 *      "查的时候还没有、插的时候撞唯一约束"会成为一类偶发的 500。
 *
 * @limitation 一：只存 payload 的 sha256，不存原文（理由与 @see 见 ../ports/webhooks.ts）。
 * @limitation 二：本文件不负责重试或补处理：那属于每日对账任务（F13）。
 *
 * @see ../ports/webhooks.ts（契约与全部设计理由）；migrations/003_idempotency_and_identity.sql；
 *      migrations/005_webhook_processing_lease.sql；docs/自主决策记录.md AJ-32 / AJ-38 / AJ-39
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import {
  DEFAULT_PROCESSING_LEASE_MS,
  type ClaimResult,
  type WebhookEventInput,
  type WebhookStore,
} from '../ports/webhooks.js';

/**
 * 造一个回调事件存储。
 *
 * @why 工厂而不是"每个函数都带一个 db 入参"：db 只在**装配时**出现一次，
 *      调用方拿到的是**能力**而不是"一条连接 + 一堆自由函数"。
 *      将来换实现、或给存储加装饰（日志 / 埋点 / 熔断），都只改这一处；
 *      业务代码一行不动——这是"依赖注入"在这里唯一的意义。
 * @limitation 三个方法都只是薄转发：目前没有额外逻辑，看起来"多包了一层"。
 *             这层不是为了现在，是为了让"业务不认识 SQL"这件事**有地方可查**。
 */
export function createWebhookStore(db: Db): WebhookStore {
  return {
    claim: (input, leaseMs) => claimWebhookEvent(db, input, leaseMs),
    finish: (input) => finishWebhookEvent(db, input),
    releaseLease: (input) => releaseWebhookLease(db, input),
  };
}

async function claimWebhookEvent(
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
async function finishWebhookEvent(
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
async function releaseWebhookLease(
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
