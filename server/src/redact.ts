/**
 * 职责：日志脱敏（F5）——把任意结构化值变成"可以写进日志"的形状。
 * 边界：纯函数，零 IO；不负责决定"该不该记"（那是调用点与日志规范的事），只负责"记下来是安全的"。
 *
 * @why 脱敏做成一个**被日志层强制调用的纯函数**，而不是靠每个开发记得手动删字段：
 *      人会忘，函数不会。跨境业务里一次 openid / 卡号进日志，就是 APPI（日本个人信息保护法）与 PCI 级别的事故，
 *      而且日志一旦落到第三方服务（Better Stack / Sentry），删不干净。
 *
 * @limitation 一：**键名整词匹配**是主要手段，自由文本正则只是兜底。
 *              新增敏感字段时若键名不在名单里（例如 `contact_no`），不会被掩码——这是名单制的固有缺点；
 *              替代方案（对所有字符串做激进正则）会把金额、订单号、时间戳一起打码，日志直接失去可定位性。
 *              所以**新增敏感字段必须在 redact.unit.test.ts 里加一条断言**，这是名单制唯一可靠的维护方式。
 * @limitation 二：本地格式电话号码（如 11 位中国手机号、10 位美国号码）若以**裸数字**出现在非敏感键名下不会被掩码
 *              （10–11 位数字与金额/ID 无法区分）。缓解：电话必须放在 `phone`/`tel`/`mobile` 键下，会命中键名规则。
 * @limitation 三：只处理 JS 值。SQL 语句、HTTP 原文（回调 body）这类**字符串里嵌着敏感内容**的形态无法可靠脱敏——
 *              规范层面禁止记回调原文（见 docs/代码注释规范与日志体系设计.md），本函数兜不住这种用法。
 * @limitation 四：自由文本的卡号判定是**概率性的**（长度 + 卡组织首位 + Luhn + 排除 GTIN-13 四重条件）。
 *              它必然在"漏掩码"与"误掩码"之间取一个平衡点；13 位与 14 位条码是这个平衡的主要代价区。
 *              结论：**结构化字段优先**——把值放在正确键名下，比让正则去猜可靠得多。
 *
 * @tradeoff 邮箱保留域名（`a***@example.com`）、卡号/电话保留后 4 位：牺牲"完全不可识别"换取排障时的可关联性
 *           （同一个用户多次报错能否串起来）。若将来合规要求收紧，改 `maskTail` 的 keepLast 为 0 即可，单点改动。
 *
 * @see docs/代码注释规范与日志体系设计.md（脱敏红线）、docs/地基搭建清单.md F5、ADR-29
 */

/**
 * 敏感键名判定：**整词**匹配（先切词，再逐个比对）。
 *
 * @why 曾经是子串正则，于是 `company` 命中 `pan`、`hotel_name` 命中 `tel`、`discard_reason` 命中 `card`
 *      ——这些业务字段被整片打码，日志里再也查不到"哪家公司 / 为什么废弃"（复现缺陷 D10）。
 *      过度脱敏和漏脱敏同样是事故，而且**没人会报**：日志少了一块内容，只有真要查的时候才发现。
 *
 * @limitation 切词靠命名规范。若哪个键写成全小写连写（`apisecret`），切词只能切出一个词
 *              （`apisecret`）从而漏判——因此短语表额外对"去掉分隔符后的整键"再比一次，
 *              但仍覆盖不到自造拼写。缓解：新增敏感字段时**必须**在本文件加一条测试。
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'credential',
  // 卡与支付
  'card',
  'pan',
  'cvv',
  'cvc',
  'iban',
  // 联系方式
  'phone',
  'telephone',
  'tel',
  'mobile',
  'email',
  // 微信身份
  'openid',
  'unionid',
  // 签名与散列
  'signature',
  'nonce',
]);

/**
 * 敏感短语（整键去分隔符后比对）。
 * @why `key` 是极通用的词（`idempotency_key` / `sort_key` / `primary_key` 都不是秘密），
 *      不能进单词表；但 `api_key` / `private_key` 这类是硬凭证。用短语表精确列举，
 *      换来的是"幂等键仍可在日志里查到"——排查重复下单时它是唯一线索。
 */
const SENSITIVE_PHRASES: ReadonlySet<string> = new Set([
  'apikey',
  'accesskey',
  'privatekey',
  'sessionkey',
  'secretkey',
  'signingkey',
  'encryptionkey',
  'masterkey',
  'accountno',
  'accountnumber',
]);

/** 把键名切成小写单词：`apiKey` / `api_key` / `api-key` / `APIKey` → ['api','key']。 */
function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase 边界
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // 连续大写后的边界（HTTPServer）
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  const squeezed = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_PHRASES.has(squeezed)) return true;
  return splitWords(key).some((w) => SENSITIVE_WORDS.has(w));
}

/**
 * 邮箱：保留首字符与域名，便于把同一用户的多次报错串起来排查。
 * 字符类按 RFC 5322 的 atext 展开（`!#$%&'*+/=?^_`{|}~` 都是合法本地部分字符）——
 * 只用 `[A-Za-z0-9._%+-]` 会让含 `&` 的邮箱整条**匹配不上**从而漏掩码（属性测试反例 `a&@a.aa` 抓到的）。
 */
const EMAIL_RE =
  /([A-Za-z0-9!#$%&'*+/=?^_`{|}~._-])([A-Za-z0-9!#$%&'*+/=?^_`{|}~._-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * 候选长数字串：13–19 位，允许单个空格或连字符分隔，前后**不得**紧邻字母或数字。
 *
 * @why 只是"候选"：光凭长度无法区分卡号、JAN 条码与毫秒时间戳（复现缺陷 D11），
 *      真正的判定交给 {@link isCardLike}，正则只负责把候选片段圈出来。
 * @why 前后都排除**字母**而不只是数字：订单号 `W20260922-000001` 的数字段（14 位、2 开头、恰好过 Luhn）
 *      会被当成卡号打码成 `W***0001`——单号是排障第一索引，抹掉它比漏一个卡号更痛。
 *      真实卡号在文本里总是被分隔符或标点包围，不会紧贴字母，这个收紧是安全的。
 */
const LONG_DIGITS_RE = /(?<![\dA-Za-z])(?:\d[ -]?){12,18}\d(?![\dA-Za-z])/g;

/** Luhn（ISO/IEC 7812 卡号校验位算法）。 */
function isLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * GTIN-13 / JAN-13 校验位（权重 1-3-1-3…，与 Luhn 是**不同**的算法）。
 * @why 日本商品条码（JAN-13，450–459 / 490–499 开头）与卡号一样是 13 位数字，
 *      单靠 Luhn 分不开（实测 `4901234567894` 同时通过 Luhn 与 GTIN）。
 *      两种算法同时通过的概率约 1/10，但**先用 GTIN 排除真条码**能保住绝大多数商品条码。
 */
function isGtin13(digits: string): boolean {
  if (digits.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += (digits.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(12) - 48;
}

/**
 * 候选数字串是不是"像卡号"。三重条件缺一不可：
 *  ① 首位必须是卡组织号段 `[2-6]`（Visa 4 / Mastercard 2·5 / Amex·JCB·Diners 3 / Discover·银联 6）——
 *     没有任何卡组织以 0/1/7/8/9 开头，这一条把**毫秒时间戳**（13 位、1 开头）挡在门外；
 *  ② 通过 Luhn；
 *  ③ 13 位时额外要求"不是合法 GTIN-13"，否则会误伤 JAN 条码。
 *
 * @limitation 一：13 位且同时通过两种校验的数字会被判成条码而**不掩码**。
 *               13 位卡号（早期 Visa）事实上已绝迹，接受这个方向的误判。
 * @limitation 二：14 位（ITF-14 箱码）与 16 位条码无独立校验算法可借用，若出现在自由文本里会被当成卡号掩码。
 *               缓解：条码应放在 `jan_code` / `barcode` 这类**非敏感键名**下（键名规则不命中，仍走文本规则，
 *               因此排障时优先用结构化字段而不是把对象打成字符串）。
 */
function isCardLike(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[2-6]/.test(digits)) return false;
  if (!isLuhn(digits)) return false;
  if (digits.length === 13 && isGtin13(digits)) return false;
  return true;
}

/** 国际格式电话（+81…/+86…/+1…）：保留后 4 位。 */
const INTL_PHONE_RE = /\+\d[\d\s-]{7,}\d/g;

/**
 * 微信 openid：**恰好 28 位**，形如 `o6_bmjrPTlm6_2sgVt7hMZOPfL2M`。
 *
 * @why 曾经写成 `o` + 20 位以上任意字符，于是我们自己的内部 ID `o_01J8ZK3M7N5P9QRSTVWXY`
 *      被打成 `o_***XY`（复现缺陷 D11）——内部订单/意图 ID 是排障主线，被抹掉等于断链。
 *      真 openid 的第二个字符是字母数字（`o6_…`），而我们的 ID 前缀是 `o_`（下划线），
 *      靠"第二位字符集 + 定长 28"就能干净地区分。
 * @limitation 若微信将来调整 openid 长度，本正则会漏。键名规则（`openid` / `unionid`）是主防线，
 *             文本正则只是兜底，这也是为什么规范要求"身份字段必须放在正确键名下"。
 */
const OPENID_RE = /(?<![A-Za-z0-9_-])o[A-Za-z0-9][A-Za-z0-9_-]{26}(?![A-Za-z0-9_-])/g;

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
    .replace(LONG_DIGITS_RE, (m) => (isCardLike(m) ? maskTail(m) : m))
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
  // 数字也要判卡号：`{ note: 4111111111111111 }` 曾经**原样**进日志（复现缺陷 D12）。
  // 只判整数且必须是安全整数——小数（金额汇率）与超大整数（BigInt 另走分支）都不可能是卡号。
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && isCardLike(String(value))
      ? maskTail(String(value))
      : value;
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') return value;
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
    out[key] = isSensitiveKey(key) ? maskByKey(v) : redact(v, depth + 1, seen);
  }
  return out;
}

/**
 * 键名命中敏感名单时的处理：字符串 / 数字保留尾 4 位，其余一律整体掩码。
 *
 * @why 数字分支是缺陷 D12 的另一半：`{ card_no: 4242424242424242 }`（数字）曾经因为
 *      `typeof value === 'string'` 判不中而落到 `'***'` 之外、甚至原样输出。
 * @limitation 小数与非整数一律整值掩码（无法判断"尾 4 位"的语义）。
 */
function maskByKey(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    // 邮箱走专门的掩码（保留域名），其余保留后 4 位
    if (value.includes('@')) return maskText(value);
    return maskTail(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return maskTail(String(value));
  return '***';
}
