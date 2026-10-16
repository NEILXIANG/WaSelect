/**
 * 职责：admin-web 的**展示格式化**（金额 / 时间）。
 *
 * @why 独立成共享模块而不是留在某个业务 view 里：管理端至少有三处要显示钱与时间
 *      （订单、运费分档、展示汇率），每处抄一份的结果就是"同一个金额在两个页面长得不一样"，
 *      而格式不一致的表现是**没人会报错**——只会被当成"那边显示错了"。
 *
 * @limitation 一：金额千分位**自己拼**，不用 `toLocaleString`——
 *              它跟随浏览器语言区，两台机器会把同一笔钱显示成两个样子（1,234 vs 1.234）。
 * @limitation 二：时间**恒显 JST**（+09:00），不跟随浏览器时区——
 *              管理员出差或用海外 IP 登录时，本地时区会把"下单时间"整体错开几小时，
 *              而客服是拿这个时间跟客户对口径的。
 *
 * @tradeoff `formatJst` 用了 `Date.parse` / `Date` 构造器：F10 的「禁 `new Date()`」
 *           针对的是**业务判定**（到期、TTL、账期），展示层的时区换算没有第二条实现路径
 *           （除非引入日期库），收益不抵依赖。换算后仍走 `toISOString()` 取值，
 *           所以结果**不依赖运行机器的时区**——单测可以钉死。
 */
import { CURRENCY_MINOR_DIGITS, type CurrencyCode } from '@waselect/shared';

/** JST 相对 UTC 的偏移（毫秒）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 文本框里手填的数字 → 半角并去首尾空白（排序、库存这类用文本框而不是数字框的格子）。
 * @why 两端输入测试 2026-10-12：中文输入法全角模式打出的「１２」原先一律判"必须是整数"，运营看不出差别。
 * @limitation 只做 NFKC + trim；"1,000" 这类千分位不在这里处理（排序 / 库存用不到）。
 */
export function halfWidth(raw: string): string {
  return raw.normalize('NFKC').trim();
}

/** 千分位 + 日元（@see @limitation 一）。 */
export function moneyText(jpy: unknown): string {
  if (!Number.isInteger(jpy)) return '—';
  return `${String(jpy).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} 日元`;
}

/**
 * 币种符号（只在 {@link minorMoneyText} 里用）。
 * @why CNY 用 `CN¥` 而不是 `¥`：`¥` 同时是日元符号，两个币种共用一个符号时
 *      "¥1,234" 到底是 1,234 日元还是 12.34 元人民币，只能靠上下文猜——
 *      而金额猜错的代价是客服给客户报错数字。宁可符号笨一点。
 */
const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { USD: '$', CNY: 'CN¥' };

/**
 * **最小单位整数** → 带币种符号的展示文案（B43 / AJ-214）：`3350 + USD` → `$33.50`。
 *
 * @why 必须显式区分"最小单位"与"主单位"：库里存的、接口传的**一律是最小单位**
 *      （JPY=日元，USD=分），而人读的是主单位。少了这一步的表现是 `USD 3350`——
 *      读大 100 倍，**不报错**，客服拿它答复客户、运营拿它判断是否应诉。
 *      且只有美元单会错（日元无小数位，最小单位=主单位），更难被发现。
 * @why 小数位取自 shared 的 `CURRENCY_MINOR_DIGITS` 而不是在这里写 `{JPY:0,USD:2}`：
 *      那是"第几份口径"的问题——加一种货币时两边都要改，漏一处就是下一轮 B43。
 *
 * @returns 币种未知 / 金额非整数 → `—`（脏数据不许显示成一个"看起来合理"的数字）
 */
export function minorMoneyText(amount: unknown, currency: unknown): string {
  if (typeof currency !== 'string' || !Number.isInteger(amount)) return '—';
  const key = currency.toUpperCase();
  const digits = CURRENCY_MINOR_DIGITS[key as CurrencyCode];
  if (digits === undefined) return '—';
  const symbol = CURRENCY_SYMBOL[key] ?? '';
  const neg = (amount as number) < 0;
  const abs = Math.abs(amount as number);
  const major = digits === 0 ? String(abs) : (abs / 10 ** digits).toFixed(digits);
  const [int = '0', frac] = major.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac === undefined ? grouped : `${grouped}.${frac}`;
  // 日元写「日元」后缀：`¥` 在本项目口径里是人民币（D-36），管理端详情原先显示 `mock · ¥2,700`，运营会读成人民币（2026-10-08）。
  // 不写「円」（全入口点击测试 2026-10-12：运营问"円是什么意思"——后台是中文运营看的，日文字认不得；
  // 同一次起小程序 formatJpy 也改成「日元」，两端同一个单位字）
  if (key === 'JPY') return `${neg ? '-' : ''}${body} 日元`;
  return `${neg ? '-' : ''}${symbol}${body}`;
}

/**
 * ISO 时间 → `YYYY-MM-DD HH:mm`（JST，@see @limitation 二）。
 * @returns 无法解析时返回 `—`（表格里出现 "Invalid Date" 比空着更吓人）
 */
export function formatJst(iso: unknown): string {
  if (typeof iso !== 'string' || iso === '') return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** `datetime-local` 输入框的形状（`YYYY-MM-DDTHH:mm`）。 */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * `datetime-local` 的值 → 带 `+09:00` 的 ISO 时间。
 *
 * @why 输入框给的是**没有时区**的本地串，直接发出去会被服务端按 UTC 解释——
 *      差九小时，而"汇率/ banner 晚九小时生效"不会报错，只会表现为"今天改了却没生效"，
 *      排查时会一路查到服务端。这里显式钉成 JST（@see @limitation 二）。
 * @returns 形状不符返回空串（调用方负责先校验，这里是第二道防御）
 */
export function toIsoJst(local: string): string {
  return LOCAL_DATETIME.test(local) ? `${local}:00+09:00` : '';
}

/**
 * 长 id 缩短给人看：`ord-0f3508cf-69ac-…` → `ord-0f3508cf…`（前缀 + 8 位）；短的原样。
 * @why 三端模拟测试 2026-10-11（用户要求）：36 位 uuid 进正文运营读不懂，还把一行撑成两行。
 *      全文仍要留给排查——调用方放进 title（悬停）或复制按钮，这里只管正文。
 * @limitation 只认"字母前缀 + uuid"的形状；别的长串截到 16 位，不保证截在有意义的边界上。
 */
export function shortRef(id: string): string {
  const m = /^([A-Za-z]+[-_])?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(
    id,
  );
  if (m !== null) return `${m[1] ?? ''}${m[2] ?? ''}…`;
  return id.length > 20 ? `${id.slice(0, 16)}…` : id;
}
