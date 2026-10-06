/**
 * 职责：把 error / fatal 级日志行转发到 Sentry（剩余清单 2-3 / D-52）——日志输出流的"分流"，手写 envelope，不引 SDK。
 *
 * @measured(develop.sentry.dev/sdk/data-model/envelopes/, 2026-10-06)：
 *   端点 `POST /api/<project_id>/envelope/`；鉴权可放 envelope 头的 `"dsn"` 字段；
 *   格式 = 头一行 JSON + item 头一行 JSON + payload，`\n` 分隔、UTF-8、每段单行；
 *   content-type `application/x-sentry-envelope`；示例 item 头 `{"type":"event","length":41,...}`。
 *   ⚠️ 本实现不写 `length`：文档示例带它，但 payload 以换行结尾时可省（同页"implicit length"）——
 *   NEEDS VERIFICATION：首次部署用真 DSN 发一条，确认 Sentry 后台能看到再勾掉。
 * @why 挂在**日志输出流**上而不是另造一个 `captureException` 入口：
 *      ① 进 Sentry 的就是已经过 `redact()` 的那一行——不必再写一套 beforeSend 脱敏（D-52 的要求自动满足）；
 *      ② 业务代码不用改：已有的每一处 `logger.error` 都自动上报，不会出现"记了日志却忘了上报"。
 * @why 上报失败**吞掉**、不写日志：写 error 日志会被本分流再次上报，失败时形成环。
 * @why 每分钟上限（默认 30）：一次上游故障会在一分钟里打出上千条同样的 error，全转发会把配额打光、
 *      把真正的新问题淹掉。超出的只丢上报，原日志照写。
 * @limitation 一：没有堆栈分组——message 是日志事件名（如 `order_mail_failed`），Sentry 按它聚合；
 *              未处理异常的堆栈在 extra 里是字符串，不是 Sentry 的 exception 结构。
 * @limitation 二：同步发、不排队、不重试；进程崩溃前最后一条可能来不及发出（日志仍在）。
 * @tradeoff 放弃了官方 SDK 的性能追踪、面包屑、自动上下文；换来零依赖与"脱敏只有一处"。
 */
import { randomUUID } from 'node:crypto';
import type { DestinationStream } from 'pino';
import type { SentryDsn } from '../sentry-dsn.js';

export interface SentryTeeOptions {
  dsn: SentryDsn;
  environment: string;
  /** 每分钟最多上报几条（默认 30）。 */
  maxPerMinute?: number;
  /** 发送函数（默认 fetch POST，5 秒超时）；测试注入。 */
  send?: (url: string, body: string) => Promise<unknown>;
  /** 当前毫秒（限流窗口用）；测试注入。 */
  nowMs?: () => number;
}

const REPORT_LEVELS = new Set(['error', 'fatal']);

function defaultSend(url: string, body: string): Promise<unknown> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope' },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

/** 一行日志 → envelope（不合法的行返回 null）。 */
function toEnvelope(line: string, opts: SentryTeeOptions): string | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = row['level'];
  if (typeof level !== 'string' || !REPORT_LEVELS.has(level)) return null;
  const { event, ts, service } = row;
  // level / env 已有专门字段，不再重复塞进 extra
  const extra = Object.fromEntries(
    Object.entries(row).filter(([k]) => !['event', 'ts', 'level', 'service', 'env'].includes(k)),
  );
  const eventId = randomUUID().replace(/-/g, '');
  const payload = {
    event_id: eventId,
    timestamp: typeof ts === 'string' ? Date.parse(ts) / 1000 : undefined,
    level,
    message: typeof event === 'string' ? event : 'log',
    logger: typeof service === 'string' ? service : 'server',
    environment: opts.environment,
    ...(typeof extra['trace_id'] === 'string' ? { tags: { trace_id: extra['trace_id'] } } : {}),
    extra,
  };
  return [
    JSON.stringify({ event_id: eventId, dsn: opts.dsn.dsn }),
    JSON.stringify({ type: 'event', content_type: 'application/json' }),
    JSON.stringify(payload),
    '',
  ].join('\n');
}

export function createSentryTee(
  inner: DestinationStream,
  opts: SentryTeeOptions,
): DestinationStream {
  const send = opts.send ?? defaultSend;
  const nowMs = opts.nowMs ?? Date.now;
  const max = opts.maxPerMinute ?? 30;
  let windowStart = nowMs();
  let count = 0;
  return {
    write(line: string): void {
      inner.write(line);
      const envelope = toEnvelope(line, opts);
      if (envelope === null) return;
      const now = nowMs();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        count = 0;
      }
      if (count >= max) return;
      count += 1;
      void send(opts.dsn.envelopeUrl, envelope).catch(() => undefined);
    },
  };
}
