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
/** JST 相对 UTC 的偏移（毫秒）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 千分位 + 円（@see @limitation 一）。 */
export function moneyText(jpy: unknown): string {
  if (!Number.isInteger(jpy)) return '—';
  return `${String(jpy).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} 円`;
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
