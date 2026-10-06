/**
 * 职责：解析 Sentry DSN（剩余清单 2-3）——纯函数，config 校验与上报适配器共用一份。
 *
 * @measured(develop.sentry.dev/sdk/data-model/envelopes/, 2026-10-06)：DSN 形如 `https://PUBLIC_KEY@HOST/PROJECT_ID`，
 *   上报端点 `POST /api/<project_id>/envelope/`；鉴权可放 envelope 头的 `dsn` 字段（本实现即如此）。
 * @why 放在 config 能用的位置（不进 adapters）：config 要在启动时拒绝"填了却解析不了"的 DSN——
 *      否则错误监控**静默**失效，直到出事那天才发现一条都没上报。
 * @limitation 不支持带路径前缀的自建 Sentry（`https://key@host/prefix/42`）：只取最后一段为项目号，前缀会被丢掉。
 */
export interface SentryDsn {
  /** 原样 DSN（envelope 头里要带完整串）。 */
  dsn: string;
  /** `https://HOST/api/<project>/envelope/` */
  envelopeUrl: string;
}

export function parseSentryDsn(raw: string): SentryDsn | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const project =
    u.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .pop() ?? '';
  if (
    (u.protocol !== 'https:' && u.protocol !== 'http:') ||
    u.username === '' ||
    !/^\d+$/.test(project)
  ) {
    return null;
  }
  return { dsn: raw, envelopeUrl: `${u.protocol}//${u.host}/api/${project}/envelope/` };
}
