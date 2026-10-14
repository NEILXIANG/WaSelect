/**
 * 职责：D-50 关单连带——订阅 `order.expired` / `order.cancelled`（及 `order.paid`，见 SESSION_CLOSE_EVENTS），
 *      把该订单的在途支付（initiated）在**库内作废**，并 **best-effort** 作废机构侧**未成功**的会话。
 *
 * @why 两个事件都要订阅：`order.cancelled` 的取消事务里已经 void 过支付行
 *      （cancel-order.ts），这里的二次 void 是幂等兜底；但**机构会话仍要作废**——
 *      库内 void 不等于机构侧会话死了（KD-1：曾按 initiated 找行导致取消路径从不作废会话）；
 *      `order.expired` 的关单 job **本体不作废支付行**——job 的职责是状态机迁移 +
 *      释放库存，支付行与机构会话的收尾归本订阅者，职责单一、各自可测。
 *
 * @why 顺序不可换：先库内 void（底线事实），后机构 expire（锦上添花）。
 *      反过来做的话，机构调用慢/挂会拖住库内作废——而库内行不废，
 *      `uq_payments_one_initiated` 就还占着"在途"的坑。机构侧失败不重试：
 *      会话有自然过期（建会话时给的 expires_at），作废只是让它**立刻**死。
 *      ⚠️ 审计 PAY-02（2026-10-14）起：结果未知的失败按退避重试（SessionExpiryDeps.retryDelaysMs），确定拒绝不重试。
 *
 * @limitation 一：订阅者在**事务提交后**分发（withUnitOfWork/job 的既定语义），
 *              关单迁移与支付行作废之间有一个窗口期——窗口内 initiated 行还在。
 *              无害的依据：短链落地先查订单 status（expired/cancelled 直接拦），
 *              支付落账守卫看订单状态机，没有任何路径凭"有 initiated 行"就放行的。
 * @limitation 一b：**换通道**时被作废的旧会话，要等到订单**付款成功或关闭**时才在这里被作废
 *              （pay-intent 换通道只在事务内 void，不调机构；付款成功也触发，见 SESSION_CLOSE_EVENTS @why）。
 *              剩余窗口 = "已换通道、尚未付款"期间：旧托管页仍可付款，付了会以 channel_mismatch
 *              （A→B→A 时为 provider_ref_mismatch）进对账、需人工退款。登记为剩余风险（AJ-175）；
 *              彻底关掉需要 pay-intent 在换通道提交后发事件，改动面更大，留待真通道接入时一并做。
 * @limitation 二：取通道用 `getForCallback`（老单语义，禁用通道不拦）；
 *              通道整个被移出配置（getForCallback 也抛）时，库内 void 已完成，
 *              机构会话留给自然过期，记 warn 不升级——配置删除通道是运营动作，
 *              在途会话随之放弃是可接受语义（已在配置表文档口径内）。
 *
 * @see ports/payment.ts expireSession（方法契约）；app/expire-orders.ts（事件源一）；
 *      app/cancel-order.ts（事件源二）；adapters/orders.ts voidInitiatedPayment
 */
import type { Db } from '../adapters/db.js';
import { voidInitiatedPayment } from '../adapters/orders.js';
import type { EventBus } from '../ports/events.js';
import type { Logger } from '../logger.js';
import {
  ProviderRejectedError,
  type PaymentProvider,
  type PaymentRegistry,
} from '../ports/payment.js';

/**
 * 需要连带收尾的事件（新增终态事件时在这里登记）。
 * @why `order.paid` 也在内（AJ-175 补测发现）：换通道 A→B 后用 B 付了款，A 的旧会话**仍然活着**——
 *      用户若还开着 A 的托管页再付一次，就是同一单付两次（第二笔以 channel_mismatch 进对账、需人工退款）。
 *      付款成功时把"其它未成功的会话"一并作废，关掉这个窗口。
 *      handler 的取行条件（initiated/cancelled）天然排除刚成功的那一行（succeeded），不会误杀。
 */
export const SESSION_CLOSE_EVENTS: readonly string[] = [
  'order.expired',
  'order.cancelled',
  'order.paid',
];

export interface SessionExpiryDeps {
  db: Db;
  logger: Logger;
  registry: PaymentRegistry;
  /**
   * 作废失败（结果未知）后的重试间隔（毫秒）——审计 PAY-02（2026-10-14，AJ-530）。
   * @why Stripe 会话最短活 30 分钟，建会话又晚于建单，订单关闭时会话通常还活着（最多多活约 32 分钟）。
   *      原先作废失败只记 warn、不再管 ⇒ 关单后的托管页仍可付款：钱进来、订单不落账，只能人工退。
   *      默认 30s / 1 / 2 / 4 / 8 分钟（共约 15 分钟）。
   * @limitation 进程内计时器：发布 / 重启会丢掉排队中的重试，剩余窗口由会话自然过期兜底。
   */
  retryDelaysMs?: readonly number[];
  /** 计时器注入（测试用）；默认 setTimeout + unref（不拖住停机）。 */
  setTimer?: (fn: () => void, ms: number) => void;
}

/** 默认重试间隔（@see SessionExpiryDeps.retryDelaysMs）。 */
export const SESSION_EXPIRE_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 120_000, 240_000, 480_000,
];

function defaultTimer(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  t.unref();
}

/**
 * 注册订阅者（装配处调用一次）。
 * @why 订阅者**必须自带测试**（business-events.ts @limitation 一）：订阅者失败是
 *      静默的——总线兜住异常落 error，请求照常成功，是系统里最容易漏测的一类代码。
 */
export function registerSessionExpiryOnClose(bus: EventBus, deps: SessionExpiryDeps): void {
  const log = deps.logger.child({ module: 'session-expiry' });
  const delays = deps.retryDelaysMs ?? SESSION_EXPIRE_RETRY_DELAYS_MS;
  const setTimer = deps.setTimer ?? defaultTimer;

  /**
   * 作废一个会话；结果未知的失败按 `delays` 退避重试。
   * @why 机构**确定拒绝**（`ProviderRejectedError`，4xx：会话已过期 / 已完成 / 不存在）不重试——会话已经付不了，再打只是噪音。
   */
  const expireOnce = async (
    provider: PaymentProvider & { expireSession: (ref: string) => Promise<void> },
    ref: string,
    orderId: string,
    channel: string,
    attempt: number,
  ): Promise<void> => {
    try {
      await provider.expireSession(ref);
      log.info('pay_session_expire', {
        order_id: orderId,
        result: 'ok',
        ctx: { channel, attempt },
      });
    } catch (e) {
      const definite = e instanceof ProviderRejectedError;
      const delay = definite ? undefined : delays[attempt];
      log.warn('pay_session_expire', {
        order_id: orderId,
        result: definite ? 'rejected' : delay === undefined ? 'failed' : 'retry_scheduled',
        ctx: { channel, attempt, ...(delay === undefined ? {} : { retry_in_ms: delay }) },
        err: e instanceof Error ? e.message : String(e),
      });
      if (delay !== undefined) {
        setTimer(() => {
          void expireOnce(provider, ref, orderId, channel, attempt + 1);
        }, delay);
      }
    }
  };

  const handler = async (event: { orderId?: string | undefined }): Promise<void> => {
    const orderId = event.orderId;
    if (orderId === undefined) return; // 事件不带 orderId 是发布方的 bug，但订阅者不陪葬

    // 1. 库内作废在途支付行（底线事实，先于机构调用；幂等——取消路径已在事务内 void 过，这里 0 行命中是常态）
    await voidInitiatedPayment(deps.db, orderId);

    // 2. 机构侧：该单**所有未成功**的会话都要死（KD-1，2026-09-28 测试审查实测；AJ-175）。
    //    ⚠️ 曾经只按 `status = 'initiated'` 找行：取消事务已在事务内把行 void 成 cancelled，
    //       提交后这里永远找不到行、直接 return——**用户取消的单，机构会话从不作废**，
    //       取消前已打开的托管页仍可付款，钱落到已取消的单上。
    //    现在按"有机构单号、且不是 succeeded"取全部行：既覆盖取消路径（行已是 cancelled），
    //    也覆盖换通道时被作废、但会话从未关掉的旧行（pay-intent 换通道只在库内 void，不调机构）。
    //    @tradeoff 对已经自然过期/已被作废过的会话会再调一次 expire：机构侧回"会话不可作废"之类的错，
    //    走下面的 warn 分支——代价是几条多余的 warn，换来的是"关单 ⇒ 该单所有会话都死"这条不变量。
    const sessions = await deps.db`
      select distinct provider, provider_ref from payments
       where order_id = ${orderId}
         and status in ('initiated', 'cancelled')
         and provider_ref is not null
    `;
    for (const pay of sessions) {
      const channel = String(pay.provider);
      let provider;
      try {
        provider = deps.registry.getForCallback(channel);
      } catch {
        log.warn('pay_session_expire', {
          order_id: orderId,
          result: 'skipped',
          ctx: { reason: 'channel_not_registered', channel },
        });
        continue;
      }
      if (typeof provider.expireSession !== 'function') continue; // 无会话概念的通道（端口 @why）
      await expireOnce(
        provider as PaymentProvider & { expireSession: (ref: string) => Promise<void> },
        String(pay.provider_ref),
        orderId,
        channel,
        0,
      );
    }
  };

  for (const name of SESSION_CLOSE_EVENTS) {
    bus.subscribe(name, (event) => handler(event));
  }
}
