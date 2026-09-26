/**
 * 职责：支付回调的**统一处理管线**（F11）——登记 → 归一化 → 冲突分层 → 封口。
 *       任何通道（mock / stripe / wechat）的回调在验签之后都走这一条。
 *
 * @why 这段逻辑曾经只写在骨架的 mock 回调里。F11 要接"统一分发"时只有两条路：
 *      ① 复制一份给 `/pay/callback/:channel`；② 抽出来两边共用。
 *      必须选 ②，而且理由不是"少写代码"——是**这份逻辑本身最容易漂移**：
 *      宽限期怎么算（用 DB 时钟还是应用时钟）、"已是 paid"算不算冲突、
 *      早到时要不要交还租约……每一条都是踩过坑才定下来的。
 *      复制一份之后，改了真实通道那一份、忘了骨架那一份（或反过来），
 *      表现就是"模拟回调能过、真实回调不落账"——而真实回调不落账等于钱收了货不发。
 *      两份逻辑迟早漂移，所以物理上只留一份。
 *
 * @why 入参是**归一化后的 `ProviderEvent`**，不是原始报文：
 *      验签与解析属于各 Provider 的差异部分（`parseWebhook`），
 *      落账与冲突分层属于所有通道共有的部分。这条分界线让"新增通道"只需要写前者。
 *
 * @limitation 一：**只处理 `outcome === 'succeeded'`**；其余（failed/expired/refunded/disputed/unknown）
 *              一律 2xx 收下 + 登记为 `ignored:<outcome>`，不落任何业务状态。
 *              MVP 的订单状态机（F12）还没有"支付失败/过期关单"与"拒付冻结"的落点，
 *              现在硬写只会写出一个谁也没验证过的分支。
 *              ⚠️ 代价：`checkout.session.expired` 到达时订单**不会**自动关闭，
 *              仍要靠超时关单任务（D-43）兜；`charge.dispute.created` 到达时也不会冻结订单。
 *              这两条都是**已知缺口**，不是遗漏——F12 接状态机时把它们排进去。
 *              @upgrade F12：按 outcome 分派到状态机的对应迁移，并补各自的测试。
 * @limitation 二：HTTP 应答形状（状态码与 body）**由本文件决定**，路由层不改写。
 *              好处是"机构收到什么"只有一个地方说了算；代价是本文件同时管业务与协议，
 *              将来若某个机构要求特殊的应答体（微信要求 XML/特定字段），
 *              需要在这里加一个 per-channel 的应答适配，而不是在路由里 if-else。
 * @limitation 三：`apply` 抛出的**非** 40400/40902 异常会原样向上抛（由 http.ts 兜成 50000）。
 *              这是刻意的：那说明业务代码有 bug，让机构看到 5xx 从而重发，
 *              比在这里吞掉更接近正确——但**登记行不会被封口**（processed_at 保持 NULL），
 *              所以它会作为"待对账"出现在 F13 的清单里，不会静默消失。
 *
 * @see ports/webhooks.ts（四态登记与租约语义）；ports/payment.ts（ProviderEvent）；
 *      docs/自主决策记录.md AJ-32（回调早到宽限期，含"用 DB 时钟做减法"的教训）；
 *      docs/地基搭建清单.md F11
 */
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ProviderEvent } from '../ports/payment.js';
import { payloadHash, type WebhookStore } from '../ports/webhooks.js';

export interface CallbackPipelineDeps {
  webhooks: WebhookStore;
  logger: Logger;
  /**
   * 回调早到宽限期（毫秒）：订单不存在且距**首次**到达不超过它 → 503 让机构重发。
   * @see skeleton.ts 的 `callbackOrderGraceMs`（同一口径，本文件不发明新默认值）
   */
  graceMs: number;
  /**
   * 把事件落到业务状态上。
   *
   * @param channel 回调来自哪个通道。**必须**带进来（三审 S1②）：落账要把
   *      "钱是从这条通道来的"与登记过的 `payments.provider` 对上，
   *      只给 `event` 的话调用方无从知道通道名——而 `event` 里没有它
   *      （那是有意的：ProviderEvent 只描述"机构说了什么"，不描述"我们怎么接的"）。
   * @throws {AppError} 40400（订单不存在）/ 40902（状态不允许本次迁移，或核对不符）
   */
  apply: (event: ProviderEvent, channel: string) => Promise<void>;
}

/**
 * 本次回调的**处置结果**——业务语义，与 HTTP 状态码是两件事。
 *
 * @why 分开表达：状态码是给机构看的（要不要重发），disposition 是给我们自己看的
 *      （要不要记业务日志、要不要上报指标）。两者不是一一对应：
 *      `duplicate` 与 `paid` 都是 200，但前者不该触发"支付成功"的埋点。
 *      只用状态码区分的写法会长成 `status===200 && !('duplicate' in body)`，
 *      那是在用协议形状反推业务语义——加一个字段比将来去猜要便宜得多。
 */
export type CallbackDisposition =
  /** 首次处理且已落账 */
  | 'paid'
  /** 同一 event_id 的重复投递，未处理 */
  | 'duplicate'
  /** 别人正在处理（租约未过期） */
  | 'inflight'
  /** 订单不存在但在宽限期内：已交还租约，等机构重发 */
  | 'early'
  /** 订单不存在且超过宽限期：转对账 */
  | 'unmatched'
  /** 订单已是 paid（另一事件类型到达，N13：正常形态） */
  | 'paid:already'
  /** 其它状态冲突（重发也不会变） */
  | 'status_conflict'
  /** 归一化结果不是 succeeded（@limitation 一） */
  | 'ignored';

/** 回调的 HTTP 应答（由本管线一次决定，路由层不改写）。 */
export interface CallbackOutcome {
  /** 业务处置（见 {@link CallbackDisposition}）。 */
  disposition: CallbackDisposition;
  status: number;
  body: Record<string, unknown>;
  /** 需要时给机构的重发节奏提示（秒）；有值时路由层必须写成 `Retry-After`。 */
  retryAfter?: number | undefined;
}

/**
 * 处理一次已验签的回调。
 *
 * @param channel 通道名（= 登记表里的 `provider`）。
 * @param raw **原始字节**：只用来算摘要，绝不在验签之后重新序列化再去算。
 * @param event Provider 归一化后的事件。
 */
export async function handleProviderCallback(
  deps: CallbackPipelineDeps,
  channel: string,
  raw: Buffer,
  event: ProviderEvent,
): Promise<CallbackOutcome> {
  const webhook = {
    provider: channel,
    eventId: event.eventId,
    eventType: event.rawType,
    hash: payloadHash(raw),
  };

  // ── 登记（D3）：先落一行"我们收到过"，再去处理 ──────────────────────────
  // @why 顺序不能反：只有"收到"是确定的，处理结果可能失败、可能冲突、可能崩溃。
  //      处理完才登记的话，"处理到一半崩了"的回调在表里彻底消失，
  //      对账任务永远看不到它——而那正是最需要被看到的那一类。
  const claim = await deps.webhooks.claim(webhook);

  if (claim.state === 'handled') {
    // 重复投递：收下，不重复处理——但必须留一条可检索的日志，
    // 否则"机构在重发"这件事会被当成"一切正常"
    deps.logger.info('webhook_duplicate', {
      order_id: event.orderId,
      provider: channel,
      result: 'ignored',
      ctx: { event_id: event.eventId },
    });
    return {
      disposition: 'duplicate',
      status: 200,
      body: { received: true, order_id: event.orderId, duplicate: true },
    };
  }

  /**
   * `inflight` = 另一个请求**正在**处理这个事件（租约未过期）。
   * @why 回 503 而不是 2xx：2xx 会让机构认为"处理完了"从而停止重发，
   *      而我们这侧若那一次最终失败（进程崩了），就没有第二次机会了
   *      ——只能等每日对账（F13），"钱到单未付"多滞留一天不可接受。
   * @why 不在这里**等**对方处理完：回调响应要尽量短（机构侧通常 5–30s 超时），
   *      而机构的重发机制本来就是为"稍后再试"设计的，等它重发比我们占着连接更划算。
   */
  if (claim.state === 'inflight') {
    deps.logger.info('webhook_inflight', {
      provider: channel,
      result: 'deferred',
      ctx: { event_id: event.eventId },
    });
    return {
      disposition: 'inflight',
      status: 503,
      retryAfter: 10,
      body: { received: false, reason: 'already_processing' },
    };
  }
  // 走到这里：claim.state 是 'new' 或 'retry'，本次是唯一持有者（N22 栅栏）
  /**
   * 栅栏令牌。**一次取出、一次校验**，后面六处直接用 `token`（不再 `claim.token ?? ''`）。
   *
   * @why 原先每处写 `claim.token ?? ''`，看着"宽容"，实际是**把不变式违反变成静默事故**：
   *      空令牌会被栅栏判成"租约已易主" → `finish` 返回 false → 钱已经付了、
   *      而 `result` 没写进事件行，举证表上留下一条"处理过但没有结果"的行，且**没有任何告警**。
   *      登记实现若真违反"new/retry 必带令牌"这条不变式，那是我们自己的 bug，
   *      就该 5xx 让机构重发（登记行未封口 = 对账信号，@limitation 三），而不是悄悄写个空串。
   * @why 顺带消灭了 6 条**构造上不可达**的分支：它们原本只能靠"造一个坏的存储实现"来覆盖，
   *      而为了覆盖率去写那种用例正是 AJ-37 明令禁止的（不许为凑覆盖率写假测试）；
   *      收敛成一处之后，它变成 2 条分支且**真的可测**（见 pay-callback.unit.test.ts）。
   */
  const token = claim.token;
  if (token === undefined) {
    throw new AppError(50000, {
      reason: 'claim 返回 new/retry 却没有栅栏令牌：登记实现违反了它自己的不变式',
      ctx: { provider: channel, event_id: event.eventId },
    });
  }

  // ── 非"支付成功"的事件：收下、登记、不落账（@limitation 一）──────────────
  if (event.outcome !== 'succeeded') {
    deps.logger.warn('callback_outcome_ignored', {
      order_id: event.orderId,
      provider: channel,
      result: 'ignored',
      ctx: { event_id: event.eventId, outcome: event.outcome, raw_type: event.rawType },
    });
    await deps.webhooks.finish({
      ...webhook,
      result: `ignored:${event.outcome}`,
      token,
      note: `归一化结果为 ${event.outcome}：MVP 不落业务状态（F12 接状态机后补）`,
    });
    return {
      disposition: 'ignored',
      status: 200,
      body: { received: true, order_id: event.orderId, ignored: event.outcome },
    };
  }

  // ── 冲突分层（AJ-32/N4/N13）────────────────────────────────────────────
  // ① 订单不存在 + 宽限期内 → 503：让机构的重发机制替我们兜底，
  //    processed_at 保持 NULL（对账信号 + 重发能补上）。
  //    旧行为是一律 2xx——"可重试"的登记被 200 抵消，机构永不重发（N4）。
  // ② 订单不存在 + 超过宽限期 → 2xx + error 告警 + 落 unmatched 转对账：
  //    脏回调不该无限占用机构重发队列，但"钱到单未付"也绝不能静默。
  // ③ 订单已是 paid → paid:already + info：同一订单的另一事件类型到达是正常形态
  //    （N13：先 payment_intent.succeeded 后 checkout.session.completed），告警会淹没真正的冲突。
  // ④ 其余状态冲突（expired/cancelled 等）→ 2xx + warn：重发不会变，靠人查。
  try {
    await deps.apply(event, channel);
  } catch (e) {
    const code = e instanceof AppError ? e.code : 0;
    if (code === 40400) {
      // ⚠️ 用 **DB 时钟**做减法（claim.nowAt 与 firstReceivedAt 同源）：
      //    应用时钟与 DB 时钟不同源，拿 Date.now() 减 received_at 会让宽限期被时钟偏移扭曲
      //    ——最坏情况是"钱到单未付"被静默判成超期（@see ports/webhooks.ts ClaimResult.nowAt）
      const elapsedMs = claim.nowAt.getTime() - claim.firstReceivedAt.getTime();
      // ⚠️ 严格小于（不是 <=）："宽限期 = 0"必须是**零宽限**，
      //    写成 <= 则 elapsed 恰为 0 时仍算宽限期内，而 DB 时钟下"刚到"就是 0
      if (elapsedMs < deps.graceMs) {
        deps.logger.warn('callback_early', {
          order_id: event.orderId,
          result: 'retry_scheduled',
          ctx: { event_id: event.eventId, grace_ms: deps.graceMs },
        });
        /**
         * ⚠️ **必须交还租约**（N22 的补丁，被自己的 e2e 抓出来）：
         *    这个请求到此结束，它并不在"处理中"，租约却还挂在它名下 10 秒。
         *    不交还的话，机构按 Retry-After 发来的重投会被判成 inflight（再吃一个 503），
         *    "早到 → 重发 → 补上"这条链被租约自己掐断——而它正是"钱到单未付"的兜底。
         */
        await deps.webhooks.releaseLease({ ...webhook, token });
        return {
          disposition: 'early',
          status: 503,
          retryAfter: 30,
          body: { received: false, order_id: event.orderId, reason: 'order_not_found_yet' },
        };
      }
      deps.logger.error('callback_unmatched', {
        order_id: event.orderId,
        result: 'unmatched',
        ctx: { event_id: event.eventId, elapsed_ms: elapsedMs },
      });
      await deps.webhooks.finish({
        ...webhook,
        result: 'unmatched:order_not_found',
        token,
        note: '超过宽限期订单仍不存在：转入对账任务（F13），机构不必再重发',
      });
      return {
        disposition: 'unmatched',
        status: 200,
        body: { received: true, order_id: event.orderId, ignored: 'unmatched' },
      };
    }
    if (code === 40902) {
      const from = (e as AppError).details as { from?: unknown } | undefined;
      if (from?.from === 'paid') {
        deps.logger.info('paid_already', {
          order_id: event.orderId,
          result: 'ignored',
          ctx: { event_id: event.eventId },
        });
        await deps.webhooks.finish({
          ...webhook,
          result: 'paid:already',
          token,
          note: '同单另一事件类型到达，订单已是 paid（N13：正常形态，不是异常）',
        });
        return {
          disposition: 'paid:already',
          status: 200,
          body: { received: true, order_id: event.orderId, ignored: 'paid:already' },
        };
      }
      deps.logger.warn('callback_conflict', {
        order_id: event.orderId,
        conflict: 'status_conflict',
        result: 'ignored',
      });
      await deps.webhooks.finish({
        ...webhook,
        result: 'ignored:status_conflict',
        token,
        note: '业务冲突：重发也不会变，靠对账而非重试',
      });
      return {
        disposition: 'status_conflict',
        status: 200,
        body: { received: true, order_id: event.orderId, ignored: 'status_conflict' },
      };
    }
    // 其余异常：原样抛出（@limitation 三）
    throw e;
  }

  // 栅栏（N22）：带令牌写结果；false = 租约已易主，我们是迟到的旧持有者
  const wrote = await deps.webhooks.finish({
    ...webhook,
    result: 'paid',
    token,
  });
  if (!wrote) {
    deps.logger.warn('webhook_result_not_written', {
      provider: channel,
      result: 'lease_lost',
      ctx: { event_id: event.eventId },
    });
  }
  return { disposition: 'paid', status: 200, body: { received: true, order_id: event.orderId } };
}
