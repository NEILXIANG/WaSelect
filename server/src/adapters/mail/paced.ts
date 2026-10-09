/**
 * 职责：给 Mailer 加"排队 + 最小间隔"（统一结论 5.2 / AJ-426）——同一进程内逐封发送，相邻两次开始发送至少隔 `minIntervalMs`。
 *
 * @why 事件总线发后不等：daily 补发一次 emit 最多 MAIL_SWEEP_BATCH_LIMIT 个事件，提交后订阅者**同时**起跑，
 *      等于同一瞬间向服务商发几百个请求。超限回 429，而熔断器把 429 计入跳闸（ports/circuit-breaker.ts `countsTowardTrip`），
 *      同主机连续失败到阈值就熔断——同一窗口里的实时邮件、告警邮件会被一起挡掉。
 *      在 Mailer 端口上排队，补发作业仍然不认识邮件服务（mail-sweep.ts @why），实时突发（批量发货）也一并被约束。
 * @why 间隔取 200ms（每秒 5 封）而不是贴着上限：
 *      @measured: Resend 官方文档 https://resend.com/docs/api-reference/rate-limit（2026-10-09 读取）原文
 *      "The default maximum rate limit is 10 requests per second per team"，"applies across all API keys associated with your team"，
 *      超限 "receive a 429 response error code"。上限按**团队**算、跨所有密钥共享，预发与生产若同一团队就共用这 10 次，留一半余量。
 * @limitation 一：只约束**本进程**；多实例各排各的，合计仍可能超限（现为单实例）。
 * @limitation 二：排队在内存里。停机时等事件订阅者的时间由 SHUTDOWN_EVENT_DRAIN_MS 封顶（默认 7 秒 ≈ 35 封），
 *              队尾没发出去的信没有 sent 记录，次日补发作业会重新发（48 小时窗口内）。
 * @limitation 三：逐封发送——前一封慢（超时）会拖住后面的；单封最长由出站 HTTP 超时封顶。
 * @tradeoff 不读 `ratelimit-remaining` / `retry-after` 做自适应：要改 HttpClient 端口把响应头带出来，收益只在"贴着上限跑"时才有；
 *           固定间隔可预测、好测，代价是空出一半额度。
 * @see ../../app/mail-sweep.ts；./select.ts（只给 Resend 分支套上）
 */
import type { MailMessage, MailResult, Mailer } from '../../ports/mailer.js';

/** 相邻两次开始发送的最小间隔（毫秒），= 每秒 5 封。 */
export const MAIL_MIN_INTERVAL_MS = 200;

export interface PacedOptions {
  minIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function createPacedMailer(inner: Mailer, opts: PacedOptions): Mailer {
  // 队尾：下一封要等它落定；存的是"吞掉错误后"的 Promise，所以永不 reject，失败不卡队列
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  return {
    send(msg: MailMessage): Promise<MailResult> {
      const run = async (): Promise<MailResult> => {
        const wait = lastStart + opts.minIntervalMs - opts.now();
        if (wait > 0) await opts.sleep(wait);
        lastStart = opts.now();
        return inner.send(msg);
      };
      const p = tail.then(run);
      tail = p.catch(() => undefined);
      return p;
    },
  };
}
