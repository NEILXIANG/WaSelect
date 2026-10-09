/**
 * 职责：小程序前端报错 → 微信实时日志（AJ-421）。`app.js` 的 `onError` / `onUnhandledRejection` 只转交到这里。
 *
 * @why 进**实时日志**，不进 `/beacon`：beacon 是用户行为流（user_events，只收白名单事件），
 *      报错的自由文本混进去违反约束七的分流；实时日志与请求层的 api_failed 是同一条运行日志流。
 * @why 写之前先打码（邮箱 / 国际电话 / 长数字串，口径同 server/src/redact.ts 的 maskText 子集）：
 *      实时日志在微信后台可被有权限的人检索，约束七的脱敏红线同样适用。
 * @why 同一消息只记一次、每次启动最多 20 条：一个渲染循环里的错误会在每次 setData 时重复抛，
 *      不限量会把实时日志的配额与检索面一起打满。
 * @limitation 一：实时日志要正式 AppID 才能在微信后台检索；拿到 AppID 之前只在开发者工具控制台可见。
 * @limitation 二：打码只认形态（邮箱、带 + 的国际电话、≥10 位数字），不认姓名、地址行、openid——
 *              它们没有可靠的形态特征，按形态猜会把调用栈里的标识符也打掉。
 * @limitation 三：不上报到服务端：报错只留在微信侧（服务端 Sentry 看不到小程序的错误），见 AJ-421 反向风险。
 * @see ../app.js；server/src/redact.ts（maskText）；docs/自主决策记录.md AJ-421
 */

const EMAIL_RE = /([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const INTL_PHONE_RE = /\+\d{8,15}/g;
const LONG_DIGITS_RE = /\d{10,}/g;

const MESSAGE_MAX = 500;
const STACK_MAX = 1000;

const tail4 = (s) => `***${s.replace(/\D/g, '').slice(-4)}`;

/** 文本里的邮箱 / 国际电话 / 长数字串打码。 */
export function maskErrorText(text) {
  return String(text)
    .replace(EMAIL_RE, (_m, first, domain) => `${first}***@${domain}`)
    .replace(INTL_PHONE_RE, tail4)
    .replace(LONG_DIGITS_RE, tail4);
}

/** 任意抛出物 → 消息与调用栈（`onError` 给的是字符串，`onUnhandledRejection` 的 reason 可能是任何东西）。 */
function describe(thrown) {
  if (thrown instanceof Error)
    return { message: thrown.message || thrown.name, stack: thrown.stack };
  if (typeof thrown === 'string') return { message: thrown, stack: undefined };
  try {
    return { message: JSON.stringify(thrown) ?? String(thrown), stack: undefined };
  } catch {
    return { message: String(thrown), stack: undefined };
  }
}

/**
 * @param {{logger: () => ({error?: (...a: unknown[]) => void} | undefined), maxPerLaunch?: number}} deps
 *   `logger` 每次现取（实时日志器可能在启动早期还拿不到）
 */
export function createErrorLog(deps) {
  const max = deps.maxPerLaunch ?? 20;
  const seen = new Set();
  let count = 0;
  return {
    /** @param {'error'|'rejection'} kind */
    record(kind, thrown) {
      const d = describe(thrown);
      const message = maskErrorText(d.message).slice(0, MESSAGE_MAX);
      if (message === '' || seen.has(message) || count >= max) return;
      seen.add(message);
      count += 1;
      const body = { kind, message };
      if (typeof d.stack === 'string' && d.stack !== '') {
        body.stack = maskErrorText(d.stack).slice(0, STACK_MAX);
      }
      try {
        deps.logger()?.error?.('client_error', JSON.stringify(body));
      } catch {
        // 记日志失败不能变成新的报错（onError 里再抛会形成环）
      }
    },
  };
}
