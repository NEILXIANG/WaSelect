/**
 * 职责：日志脱敏（F5）——把任意结构化值变成"可以写进日志"的形状。
 * 边界：纯函数，零 IO；不负责决定"该不该记"（那是调用点与日志规范的事），只负责"记下来是安全的"。
 *
 * @why 脱敏做成一个**被日志层强制调用的纯函数**，而不是靠每个开发记得手动删字段：
 *      人会忘，函数不会。跨境业务里一次 openid / 卡号进日志，就是 APPI（日本个人信息保护法）与 PCI 级别的事故，
 *      而且日志一旦落到第三方服务（Better Stack / Sentry），删不干净。
 *
 * @limitation 一：**键名名单制**是主要手段，自由文本正则只是兜底。
 *              新增敏感字段时若键名不在名单里（例如 `contact_no`），不会被掩码——这是名单制的固有缺点；
 *              替代方案（对所有字符串做激进正则）会把金额、订单号、时间戳一起打码，日志直接失去可定位性。
 * @limitation 二：本地格式电话号码（如 11 位中国手机号、10 位美国号码）若以**裸数字**出现在非敏感键名下不会被掩码
 *              （10–11 位数字与金额/ID 无法区分）。缓解：电话必须放在 `phone`/`tel`/`mobile` 键下，会命中键名规则。
 * @limitation 三：只处理 JS 值。SQL 语句、HTTP 原文（回调 body）这类**字符串里嵌着敏感内容**的形态无法可靠脱敏——
 *              规范层面禁止记回调原文（见 docs/代码注释规范与日志体系设计.md），本函数兜不住这种用法。
 *
 * @tradeoff 邮箱保留域名（`a***@example.com`）、卡号/电话保留后 4 位：牺牲"完全不可识别"换取排障时的可关联性
 *           （同一个用户多次报错能否串起来）。若将来合规要求收紧，改 `maskTail` 的 keepLast 为 0 即可，单点改动。
 *
 * @see docs/代码注释规范与日志体系设计.md（脱敏红线）、docs/地基搭建清单.md F5、ADR-29
 */

/** 键名命中即整体（或按类型）掩码：不区分大小写、子串匹配。 */
const SENSITIVE_KEY =
  /(secret|token|password|passwd|api_?key|access_?key|authorization|cookie|credential|private_?key|card|pan|cvv|cvc|phone|tel|mobile|email|openid|unionid|session_?key)/i;

/**
 * 邮箱：保留首字符与域名，便于把同一用户的多次报错串起来排查。
 * 字符类按 RFC 5322 的 atext 展开（`!#$%&'*+/=?^_`{|}~` 都是合法本地部分字符）——
 * 只用 `[A-Za-z0-9._%+-]` 会让含 `&` 的邮箱整条**匹配不上**从而漏掩码（属性测试反例 `a&@a.aa` 抓到的）。
 */
const EMAIL_RE =
  /([A-Za-z0-9!#$%&'*+/=?^_`{|}~._-])([A-Za-z0-9!#$%&'*+/=?^_`{|}~._-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/** 卡号 / 长数字串（13–19 位，允许空格或连字符分隔）：只保留后 4 位。 */
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** 国际格式电话（+81…/+86…/+1…）：保留后 4 位。 */
const INTL_PHONE_RE = /\+\d[\d\s-]{7,}\d/g;

/** 微信 openid：`o` + 20+ 位 base64 变体字符。 */
const OPENID_RE = /\bo[A-Za-z0-9_-]{20,}\b/g;

/** 递归深度上限：防止自引用/超深对象把日志进程拖死。 */
const MAX_DEPTH = 6;

/** 保留尾部 n 位，其余打星。 */
function maskTail(digits: string, keepLast = 4): string {
  const digitsOnly = digits.replace(/\D/g, '');
  const tail = digitsOnly.slice(-keepLast);
  return `***${tail}`;
}

/** 掩码字符串值中的各类敏感片段（兜底正则层）。 */
export function maskText(text: string): string {
  return text
    .replace(
      EMAIL_RE,
      (_m, first: string, _rest: string, domain: string) => `${first}***@${domain}`,
    )
    .replace(CARD_RE, (m) => maskTail(m))
    .replace(INTL_PHONE_RE, (m) => maskTail(m))
    .replace(OPENID_RE, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`);
}

/**
 * 脱敏任意值。
 * @param value 任意 JS 值（对象 / 数组 / Error / 原始值）
 * @returns 可安全写入日志的新对象（**不修改入参**）
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return maskText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  // Error：pino 的标准序列化会丢 message 之外的自定义字段，这里手工摊平，保证 err_type/err_message 可检索
  if (value instanceof Error) {
    return {
      err_type: value.name,
      err_message: maskText(value.message),
      ...(value.stack ? { err_stack: maskText(value.stack) } : {}),
    };
  }

  if (depth >= MAX_DEPTH) return '[Deep]';
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? maskByKey(key, v) : redact(v, depth + 1, seen);
  }
  return out;
}

/** 键名命中敏感名单时的处理：字符串保留尾 4 位，其余一律整体掩码。 */
function maskByKey(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    // 邮箱走专门的掩码（保留域名），其余保留后 4 位
    if (value.includes('@')) return maskText(value);
    return maskTail(value);
  }
  return '***';
}
