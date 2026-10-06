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
 * @tradeoff 三类口径（AJ-33）的各自取舍：SECRET 整值遮蔽放弃"对尾号"的便利（口令/密钥本就不该对）；
 *           IDENTIFIER 保留尾 4 位/域名牺牲部分不可识别性换取对账可关联；
 *           PII 姓名保留首字母是辨识度与匿名的折中。
 *           若将来合规要求收紧，把 IDENTIFIER 的 `maskTail` keepLast 改 0 即可，单点改动。
 *
 * @see docs/代码注释规范与日志体系设计.md（脱敏红线）、docs/地基搭建清单.md F5、ADR-29；
 *      docs/自主决策记录.md AJ-33（三类口径，二审 N5/N6）
 */

/**
 * 敏感键名判定：**整词**匹配（先切词，再逐个比对），并分出**三类**（AJ-33，二审 N5/N6）。
 *
 * @why 曾经是子串正则，于是 `company` 命中 `pan`、`hotel_name` 命中 `tel`、`discard_reason` 命中 `card`
 *      ——这些业务字段被整片打码，日志里再也查不到"哪家公司 / 为什么废弃"（复现缺陷 D10）。
 *      过度脱敏和漏脱敏同样是事故，而且**没人会报**：日志少了一块内容，只有真要查的时候才发现。
 *
 * @why 三类而不是一类（N5/N6）：旧实现对所有敏感键一律"保留尾 4 位数字"——
 *      那是为卡号/电话设计的，但作用在口令/密钥上时尾 4 位数字恰是撞库高价值片段
 *      （`password:'Summer2024'` → `***2024`）；而收货人 PII（姓名/地址/邮编）不在词表里会明文落盘。
 *      - **SECRET**（口令/密钥/token/签名/cookie/cvv…）：整值 `***`，任何片段都是撞库素材；
 *      - **IDENTIFIER**（卡号/电话/邮箱/openid…）：保留尾 4 位或域名——对账排障要对得上号，
 *        且尾 4 位单独不构成可利用凭证（行业惯例）；
 *      - **PII**（收货人姓名/地址行/邮编）：整值遮蔽，姓名保留首字母（`Tanaka` → `T***`，
 *        给"这批日志大致是哪个客户的"留人工辨识度）。美国地址行+邮编+姓氏即可指向具体住户，
 *        而排查订单问题靠的是 order_id 与 trace_id，**从不需要**在日志里看到完整地址。
 *
 * @limitation 切词靠命名规范。若哪个键写成全小写连写（`apisecret`），切词只能切出一个词
 *              （`apisecret`）从而漏判——因此短语表额外对"去掉分隔符后的整键"再比一次，
 *              但仍覆盖不到自造拼写。缓解：新增敏感字段时**必须**在本文件加一条测试。
 * @limitation PII 词表的两个刻意保守边界（防止误伤业务字段，AJ-33）：
 *              ① 裸 `name` **不入**表（会误伤 `product_name`/`channel_name`）；
 *              ② `city` 保留明文（城市级粒度不构成个人识别，运费/关税排查要看）。
 *              姓名类只认整词 `recipient`/`fullname` 与整键 `firstname`/`lastname` 等——
 *              `first`/`last` 单独太通用（`last_login` 是审计字段，不能误伤）。
 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'credential',
  'signature',
  'nonce',
  'cvv',
  'cvc',
  'iban',
]);

const IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  // 卡与支付标识
  'card',
  'pan',
  // 联系方式
  'phone',
  'telephone',
  'tel',
  'mobile',
  'email',
  // 微信身份
  'openid',
  'unionid',
]);

/** PII-姓名类：保留首字母。 */
const PII_NAME_WORDS: ReadonlySet<string> = new Set(['recipient', 'fullname']);
/** PII-姓名类（整键去分隔符后比对）：`first_name` → `firstname`。 */
const PII_NAME_PHRASES: ReadonlySet<string> = new Set([
  'firstname',
  'lastname',
  'givenname',
  'familyname',
  'surname',
  'recipientname',
  'fullname',
]);
/** PII-地址/邮编类：整值遮蔽。`address_snapshot` 经切词命中 `address`，整对象 `***`。 */
const PII_ADDRESS_WORDS: ReadonlySet<string> = new Set([
  'line1',
  'line2',
  'street',
  'postal',
  'zipcode',
  'zip',
  'address',
  'addr',
]);

/**
 * 敏感短语（整键去分隔符后比对），全部归 SECRET 类。
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

/**
 * URL 类键（三审 S2）：Stripe Checkout Session 的 URL 本身就是**不记名凭证**（拿到就能付款），
 * 支付短链的查询串里是 token——它们都不在 SECRET 词表里（`pay_url` 切词得 `pay`/`url`），
 * 此前原样进日志，直接违反约束七"支付链接 token 一律不进日志"。
 * 处理方式见 {@link maskUrl}：保留 origin 与可读路径，去掉查询串/哈希，抹掉像 token 的路径段。
 */
const URL_WORDS: ReadonlySet<string> = new Set(['url', 'uri', 'link', 'href']);

/** 敏感键的类别。判定优先级：SECRET > IDENTIFIER > PII-name > PII-address > URL。 */
export type SensitiveClass = 'secret' | 'identifier' | 'pii-name' | 'pii' | 'url';

/** 把键名切成小写单词：`apiKey` / `api_key` / `api-key` / `APIKey` → ['api','key']。 */
function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase 边界
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // 连续大写后的边界（HTTPServer）
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * 复数归一（三审 S2）：`tokens` / `secrets` / `passwords` / `api_keys` 此前切词得不到单数词，
 * 整个数组明文落盘。只去尾 `s`（`keys`→`key`、`addresses`→`addresse` 不会误命中：
 * 单数本身也在查，两者取并集），不做完整词形还原——词表是封闭的，够用且可预测。
 */
function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

function hasWord(words: string[], set: ReadonlySet<string>): boolean {
  return words.some((w) => set.has(w) || set.has(singular(w)));
}

/**
 * **引用**型键（`…_id` / `…_ids`）：指向某个对象的**编号**，不是那个对象的内容。
 *
 * @why 🔴 词表制的固有坑（AJ-355）：`address_id` 切词得 `address`，命中 PII-地址词表
 *      ⇒ 整值打码成 `***`。而它是**定位键**，与 `order_id` / `trace_id` 同类——
 *      本文件自己的 @limitation 写着"排查订单问题靠的是 order_id 与 trace_id，
 *      从不需要在日志里看到完整地址"，`_id` 正是那一类。
 *      实际后果：`DELETE /addresses/{id}` 的 40400 日志、
 *      建单时"地址不存在"的 40400 日志、以及地址 CRUD 的三条业务日志，
 *      **全都不带得出来是哪一个 id** —— 用户投诉"我的默认地址怎么变了"时，
 *      日志只能回答"有过一次改动"。把编号和地址行混在同一条规则里，遮蔽的是线索本身。
 * @why 只**豁免 PII 两类**，不动 SECRET / IDENTIFIER / URL：
 *      `openid` / `unionid` 走 IDENTIFIER（判据在前面，不受本条影响），
 *      `api_key` 走 SECRET——真正危险的那几类一条都没放宽。
 *      PII 两类遮蔽的是**值**（姓名、街道、邮编），而编号从来不是这些值。
 * @limitation 复数 `…_ids`（数组）同样豁免；但 **`addresses: [...]` 这类不带 `id` 后缀的
 *             仍是整值遮蔽（切词得 `addresse` → `address`，正确——那是地址内容不是编号）。
 */
function isIdReference(squeezed: string): boolean {
  return squeezed.endsWith('id') || squeezed.endsWith('ids');
}

export function classifyKey(key: string): SensitiveClass | undefined {
  const squeezed = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_PHRASES.has(squeezed) || SENSITIVE_PHRASES.has(singular(squeezed))) return 'secret';
  const words = splitWords(key);
  if (hasWord(words, SECRET_WORDS)) return 'secret';
  if (hasWord(words, IDENTIFIER_WORDS)) return 'identifier';
  const idRef = isIdReference(squeezed); // @see isIdReference 的 @why（AJ-355）
  if (PII_NAME_PHRASES.has(squeezed) || hasWord(words, PII_NAME_WORDS)) {
    return idRef ? undefined : 'pii-name';
  }
  if (hasWord(words, PII_ADDRESS_WORDS)) return idRef ? undefined : 'pii';
  if (hasWord(words, URL_WORDS)) return 'url';
  return undefined;
}

export function isSensitiveKey(key: string): boolean {
  return classifyKey(key) !== undefined;
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
  // 防御分支（N16/AJ-37）：唯一调用方 isCardLike 已保证 13 位，长度守卫只防未来新增调用方，
  // 覆盖率上是不可达分支——显式 ignore 并在此留理由，而不是写假测试或删防御。
  /* v8 ignore next */
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

/**
 * 凭证形状的自由文本（三审 S2）：Stripe 密钥 / webhook 密钥 / Checkout Session id、Bearer 头、JWT。
 * @why 它们会出现在**错误消息**里（`stripe 建会话失败：HTTP 401 … sk_live_…`、上游回显的
 *      Authorization），而错误消息是最常被原样打进日志的字符串。键名规则管不到字符串内部。
 * @limitation 只认这几种已知前缀/形状；自造格式的密钥仍靠键名规则（redact 文件头 @limitation 一）。
 */
const CREDENTIAL_TEXT_RE =
  /\b(sk|pk|rk|whsec|cs|pi|ch|re|acct)_(live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|\bBearer\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** 路径段里像 token 的形态：≥16 位、字母数字与 `_-` 混排、且含至少一个数字（排除普通英文单词）。 */
const TOKEN_LIKE_SEGMENT_RE = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

/**
 * URL 类值的掩码：保留 origin 与可读路径段，去掉查询串与哈希，像 token 的路径段抹成 `***`。
 * @why 不整值 `***`：出站 HTTP 的排障要看"打到了哪个端点"（`/v1/checkout/sessions`），
 *      整值抹掉等于把 F12 的日志价值一起抹掉；而查询串（短链 `?t=`）与 Session id 路径段
 *     （`/c/pay/cs_live_…`）才是凭证本体。
 * @limitation 不是合法 URL 的字符串退回 maskText（键名叫 url 但值不是 URL 的形态不猜）。
 */
export function maskUrl(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return maskText(value);
  }
  const segments = u.pathname
    .split('/')
    .map((seg) => (TOKEN_LIKE_SEGMENT_RE.test(seg) ? '***' : seg));
  return `${u.origin}${segments.join('/')}`;
}

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
    .replace(OPENID_RE, (m) => `${m.slice(0, 2)}***${m.slice(-2)}`)
    .replace(CREDENTIAL_TEXT_RE, (m) => {
      // 保留可辨识的前缀（`sk_live_` / `Bearer ` / `eyJ`），值本体抹掉：排障要知道"是哪一类凭证漏了"
      const head = m.startsWith('Bearer')
        ? 'Bearer '
        : m.startsWith('eyJ')
          ? 'eyJ'
          : m.replace(/(_(live|test)_|_)[A-Za-z0-9]+$/, '$1');
      return `${head}***`;
    });
}

/** 单条日志字段里字符串的**上限**（字符数）；超出截断并留可见标记。 */
const LOG_STRING_CAP = 512;

/**
 * 截断标记：必须能让人一眼看出"这串被截过"。
 * @why 静默截断比不截断更坏——排查的人会把截断后的串当成**完整值**去库里查，
 *      查不到就开始怀疑别的地方（与"空值不产生掩码噪音"同一条理由：
 *      "本来就没值"和"有值被处理过"在日志里必须是两件能分开的事）。
 */
function truncate(s: string): string {
  return `${s.slice(0, LOG_STRING_CAP)}…(+${s.length - LOG_STRING_CAP} 字符)`;
}

/**
 * 把**已脱敏**的日志字段里的长字符串截断（CAT2-03）。
 *
 * @why 客户端可控的字符串长度**无界**：路径段（`http_path`）、`user-agent`、
 *      以及被原样塞进 `AppError.details` 的路径参数（`{ product_id: String(req.params.id) }`）。
 *      `GET /api/v1/products/<8000 字符>` 一条请求就是一条 8KB 的日志行——
 *      该端点**不鉴权、无限流**，于是任何人都能按量把日志写大；
 *      巨行还会把检索界面冲垮（一条 8KB 的行盖住一屏）。
 * @why 放在**日志出口**（`logger.ts` 的 emit）而不是 {@link redact} 内部：
 *      `redact()` 有**第二个**消费方——`admin-audit.ts` 用它算审计的 after 值，
 *      那个值要**落库**（审计表 append-only，写进去就改不了）。
 *      在 redact 里截断会把"运营提交的商品描述"这类合法的长内容一起截掉，
 *      而审计的意义正是**完整**留痕。所以限长是"写日志"这一件事的性质，不是脱敏的性质。
 * @limitation 只截断**字符串值**，且**豁免 `err_stack`**：
 *              堆栈由 V8 从**我们自己的**代码生成，不是客户端可控输入；
 *              而 `unhandled_error`（唯一带堆栈的事件）恰恰是最需要看完整堆栈的地方。
 *              豁免一个键名是有代价的（多一条规则），但代价落在"我们自己的内容"上，可以接受。
 * @limitation 数字、布尔、null 不受影响；数组与对象**逐元素**递归截断，
 *              因此"很多个中等长度的字符串"仍可能撑出一条较大的行——
 *              本条守的是"**单个**值无界"这个主要形态，不是整行字节数上限。
 */
export function capForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > LOG_STRING_CAP ? truncate(value) : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Deep]';
  if (Array.isArray(value)) return value.map((v) => capForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = k === 'err_stack' ? v : capForLog(v, depth + 1);
  }
  return out;
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

  // Date：转 ISO 串（S-02）。不单独处理时会落进下面的"普通对象"分支，`Object.entries` 为空 → `{}`，
  //   审计表里"被替换的那条汇率是哪一期"就永久丢了（审计表 append-only，补不回来）。
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  if (depth >= MAX_DEPTH) return '[Deep]';
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const cls = classifyKey(key);
    out[key] = cls === undefined ? redact(v, depth + 1, seen) : maskByClass(cls, v);
  }
  return out;
}

/**
 * 键名命中敏感名单时的处理：按类别分档（AJ-33）。
 *
 * - `secret`：整值 `***`——口令/密钥的任何片段（尾 4 位数字、年份）都是撞库素材（N5）；
 * - `pii`：整值 `***`——地址行/邮编组合即可指向具体住户（N6），排障不需要它们；
 * - `pii-name`：保留首字母——`Tanaka` → `T***`，首字母单独无法定位个人，
 *   但给"这批日志大致是哪个客户的"留人工辨识度；
 * - `identifier`：字符串 / 数字保留尾 4 位（邮箱保留域名）——对账排障要对得上号。
 *
 * @why IDENTIFIER 的数字分支是缺陷 D12 的另一半：`{ card_no: 4242424242424242 }`（数字）曾经因为
 *      `typeof value === 'string'` 判不中而落到 `'***'` 之外、甚至原样输出。
 * @limitation 小数与非整数一律整值掩码（无法判断"尾 4 位"的语义）。
 */
function maskByClass(cls: SensitiveClass, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // 空字符串不产生掩码噪音（空值掩码会误导排查——"有值被抹了"和"本来就没值"是两回事）
  if (typeof value === 'string' && value.length === 0) return value;
  switch (cls) {
    case 'secret':
    case 'pii':
      return '***';
    case 'pii-name':
      // 姓名保留首字母（AJ-33）；非字符串形态（意外传入对象/数字）整值掩码。
      // `?? ''` 是类型守卫（noUncheckedIndexedAccess 下 value[0] 是 string|undefined），
      // 运行期不可达——空字符串已在上面提前 return（N16/AJ-37 显式 ignore，非静默跳过）。
      /* v8 ignore next */
      return typeof value === 'string' ? `${value[0] ?? ''}***` : '***';
    case 'identifier':
      return maskIdentifier(value);
    case 'url':
      return typeof value === 'string' ? maskUrl(value) : '***';
  }
}

/** IDENTIFIER 类（旧 maskByKey 的行为）：字符串/数字保留尾 4 位，邮箱保留域名，其余整体掩码。 */
function maskIdentifier(value: unknown): unknown {
  if (typeof value === 'string') {
    // 邮箱走专门的掩码（保留域名），其余保留后 4 位
    if (value.includes('@')) return maskText(value);
    return maskTail(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return maskTail(String(value));
  return '***';
}
