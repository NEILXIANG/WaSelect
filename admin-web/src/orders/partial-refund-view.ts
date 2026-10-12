/**
 * 职责：管理端**部分退款**的纯函数层（AJ-383）——金额换算、可退额度、准入、列表行。
 *
 * @why 服务端收的是**支付币种最小单位**（USD 的 10.00 = 1000），运营填的是"10.00"。换算放这一处、用字符串拆整数部分与小数部分，
 *      不走 `Number(x) * 100`：浮点 0.29 × 100 = 28.999…，取整就少退一分，而这种差错没人会去核。
 * @why 准入与服务端 `partialRefundGuard` 同口径：前端拦只为"早一步说清楚"，最终以服务端为准。
 * @limitation 小数位数取 shared `CURRENCY_MINOR_DIGITS`，只覆盖 JPY / USD / CNY；认不出的币种按 2 位。
 *
 * @see server/src/domain/partial-refund.ts；./PartialRefunds.tsx；契约 0.6.35 PartialRefund
 */
import { CURRENCY_MINOR_DIGITS, type CurrencyCode } from '@waselect/shared';
import { UPSTREAM_UNAVAILABLE_CODE } from '../api/errors.js';
import { minorMoneyText } from '../format.js';
import { upstreamUnavailableNotice, type Gate } from './view.js';

interface RefundLike {
  id?: unknown;
  status?: unknown;
  currency?: unknown;
  amount_minor?: unknown;
  reason?: unknown;
  created_at?: unknown;
}

const IN_FLIGHT = new Set(['initiated', 'pending', 'unknown']);
const ALLOWED_STATUS = new Set(['paid', 'shipped', 'delivered', 'completed']);

const STATUS_TEXT: Record<string, string> = {
  initiated: '已登记（点同步取回结果）',
  pending: '机构处理中（点同步查询）',
  succeeded: '已退款',
  failed: '失败（未退，额度已释放）',
  unknown: '结果未知（点同步取回）',
};

function digitsOf(currency: string): number {
  return (CURRENCY_MINOR_DIGITS as Record<string, number>)[currency as CurrencyCode] ?? 2;
}

function refundsOf(order: unknown): RefundLike[] {
  const list = (order as { partial_refunds?: unknown } | null)?.partial_refunds;
  return Array.isArray(list) ? (list as RefundLike[]) : [];
}

/**
 * 位置正确的千分位（"2,000" / "12,345.67"）。
 * @why 三端联动走查 2026-10-08：运营最自然的写法是 "2,000"，原先一律拒、提示还举 "10.50" 当日元的例子。
 * @why **只收位置对的逗号**：`1,5` 在欧式写法里是 1.5，猜成 15 就是多退十倍——钱的输入宁拒不猜。
 */
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * 日元金额末尾的单位（AJ-437，联动走查·小白运营 2026-10-10）：只认**一个**"円 / 日元"，前面可有空格。
 * @why 运营最自然的写法之一是"1000円"；"1,000"早已照收，带单位却被拒——同一个人两种写法两种结果。
 * @why 不认"¥"：本项目口径 ¥ 是人民币（D-36），"¥1000"是哪种钱有歧义；其它币种也不认这两个字——钱的输入宁拒不猜。
 */
const JPY_UNIT = /\s*(?:円|日元)$/;

/** "10.05" → 1005（USD）；"2,000" / "1000円" → 2000 / 1000（JPY）；格式不对 / ≤0 / 小数位超出币种精度 → 拒。 */
export function parseAmountToMinor(
  raw: string,
  currency: string,
): { ok: true; minor: number } | { ok: false; reason: string } {
  const digits = digitsOf(currency);
  // S8（AJ-475）：全角数字（输入法）归一；`.5` / `1000.` 这类手误按数字收
  const bare = raw.normalize('NFKC').trim().replace(/^\./, '0.').replace(/\.$/, '');
  const trimmed = currency === 'JPY' ? bare.replace(JPY_UNIT, '') : bare;
  const plain = GROUPED.test(trimmed) ? trimmed.replace(/,/g, '') : trimmed;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(plain);
  if (m === null) {
    return { ok: false, reason: `金额只能是数字，例如 ${digits === 0 ? '2000' : '10.50'}` };
  }
  const frac = m[2] ?? '';
  if (frac.length > digits) {
    return {
      ok: false,
      // 中文币种名（两端输入测试 2026-10-12：原写"JPY 没有小数"，同处标签早已写中文名，AJ-410）
      reason:
        digits === 0
          ? `${currencyName(currency)}没有小数`
          : `${currencyName(currency)}最多 ${digits} 位小数`,
    };
  }
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  // 两种失败分开说（模拟走查 2026-10-09）：超出安全整数时说"必须大于 0"会让人去改成正数再试
  if (!Number.isSafeInteger(minor))
    return { ok: false, reason: '金额太大，请检查是不是多打了几位' };
  if (minor < 1) return { ok: false, reason: '金额必须大于 0' };
  return { ok: true, minor };
}

/** 币种的中文名（给运营看的金额标签用，AJ-410 / N28）；认不出的原样返回。 */
export function currencyName(currency: string): string {
  return (
    ({ JPY: '日元', USD: '美元', CNY: '人民币' } as Record<string, string>)[currency] ?? currency
  );
}

/** 1005 USD → "10.05 美元"（运营看到的提示与记录行都用中文币种名；`formatMinor` 只留给需要币种代码的地方）。 */
export function formatMinorCn(minor: number, currency: string): string {
  // 日元与后台其它地方同一写法"5,350 日元"（走 minorMoneyText，2026-10-12 起后台不写「円」）
  if (currency.toUpperCase() === 'JPY') return minorMoneyText(minor, 'JPY');
  const plain = formatMinor(minor, currency);
  return `${plain.slice(0, plain.length - currency.length)}${currencyName(currency)}`;
}

/** 1005 USD → "10.05 USD"；JPY 带千分位。 */
export function formatMinor(minor: number, currency: string): string {
  const digits = digitsOf(currency);
  const major = minor / 10 ** digits;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** 可退额度 = succeeded 支付行实收 − 除 failed 外的部分退款；没有 succeeded 支付行 → null。 */
export function refundableMinor(order: unknown): { currency: string; minor: number } | null {
  const pays = (order as { payments?: unknown } | null)?.payments;
  const pay = (Array.isArray(pays) ? pays : []).find(
    (p: { status?: unknown }) => p?.status === 'succeeded',
  ) as { charge_currency?: unknown; charge_amount?: unknown } | undefined;
  if (pay === undefined || typeof pay.charge_amount !== 'number') return null;
  const used = refundsOf(order)
    .filter((r) => r.status !== 'failed')
    .reduce((s, r) => s + (typeof r.amount_minor === 'number' ? r.amount_minor : 0), 0);
  return { currency: String(pay.charge_currency), minor: Math.max(0, pay.charge_amount - used) };
}

export function partialRefundGate(order: unknown): Gate {
  const status = (order as { status?: unknown } | null)?.status;
  if (typeof status !== 'string' || !ALLOWED_STATUS.has(status)) {
    return { ok: false, reason: '只有已付款 / 已发货 / 已签收 / 已完成的订单可以部分退款' };
  }
  if ((order as { has_dispute?: unknown }).has_dispute === true) {
    return {
      ok: false,
      reason: '买家正在通过银行要回货款（拒付），现在不能退款；请先到「风控」页处理',
    };
  }
  if (refundsOf(order).some((r) => IN_FLIGHT.has(String(r.status)))) {
    return { ok: false, reason: '已有一笔部分退款在途，请先点它的「同步」取回结果' };
  }
  const left = refundableMinor(order);
  if (left === null || left.minor < 1) return { ok: false, reason: '已没有可退金额' };
  // AJ-410 / N29：抽屉一打开就看得到还能退多少（中文币种名）
  return { ok: true, reason: `最多还能退 ${formatMinorCn(left.minor, left.currency)}` };
}

/**
 * 发起前的**一次性**预检：格式 → 原因 → 可退额度。
 *
 * @why 必须比对可退额度：修订前 `ask()` 只查"数字格式"与"原因非空"，从不算额度——
 *      填 999999 会直接发出去，服务端回通用「参数缺失或格式错误」（40001），
 *      运营只会以为是格式问题，反复把 999999 改写成 999,999 再试一遍。
 *      额度前端在同一个地方也算得出（`refundableMinor`），没理由等服务端话说回来。
 *
 * @why 顺序=表单自上而下（金额 → 原因 → 额度）：三条一起违反时，
 *      第一条就是他刚才光标所在的那一行。例外：**没有已成功的支付**排在最前——
 *      那时金额无论怎么填都不对，先报格式错误等于让人去改一个改不好的东西。
 *
 * @limitation 这里只做**早一步说清楚**，不是闸门：真正的额度判定仍在服务端
 *            （并发下额度可能先被别人的一笔占掉），所以这里放行也仍可能被服务端拒。
 */
export function partialRefundInputCheck(a: {
  amount: string;
  reason: string;
  order: unknown;
}): { ok: true; minor: number } | { ok: false; reason: string } {
  const left = refundableMinor(a.order);
  // ⚠️ 先判"有没有已成功的支付"（AJ-398）：没有时币种解析为 ''，金额校验会按"缺省 2 位小数"
  //    报一句格式错误——运营照着改金额永远改不对，真正的原因（没收到钱）被藏在后面。
  if (left === null) return { ok: false, reason: '这笔订单没有已成功的支付记录，无法退款' };
  const parsed = parseAmountToMinor(a.amount, left.currency);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (a.reason.trim() === '') return { ok: false, reason: '请填写退款原因（会记录下来）' };
  if (parsed.minor > left.minor) {
    return { ok: false, reason: `最多还能退 ${formatMinorCn(left.minor, left.currency)}` };
  }
  return { ok: true, minor: parsed.minor };
}

export interface PartialRefundRowView {
  id: string;
  amount: string;
  statusText: string;
  reason: string;
  createdAt: string;
  canSync: boolean;
}

export function partialRefundRows(order: unknown): PartialRefundRowView[] {
  return refundsOf(order).map((r) => ({
    id: String(r.id),
    amount: formatMinorCn(Number(r.amount_minor), String(r.currency)),
    statusText: STATUS_TEXT[String(r.status)] ?? String(r.status),
    reason: String(r.reason ?? ''),
    createdAt: String(r.created_at ?? ''),
    canSync: IN_FLIGHT.has(String(r.status)),
  }));
}

/**
 * 部分退款出错后、**重新取回订单之后**的提示（第三轮缺口 P2-49）：按那一行的真实状态说话。
 *
 * @param a.refundId 同步某一行时传它的 id；发起新一笔时不传，取 `knownIds` 之外新出现的那行
 * @param a.knownIds 发起前已有的行 id（用来认出"这次新建的那一行"）
 * @why 原实现一律只显示服务端 message（"服务器内部错误"），而行的状态其实已经定了：
 *      failed = 机构确认没退、额度已释放，可以放心重新发起；unknown / initiated = 结果未知，
 *      要点「同步」——这时去 Stripe 后台手工退就是同一笔退两次。
 * @why 50300 单独说：服务端把熔断拒绝记成 failed（请求没发出去），额度同样已释放。
 * @limitation 4xx（金额超额度、拒付中…）在建行之前就被拒，找不到新行 → 返回 ''（只显示服务端 message）。
 */
export function partialRefundErrorNotice(a: {
  code: unknown;
  retryAfterSec?: number | undefined;
  order: unknown;
  refundId?: string | undefined;
  knownIds?: readonly string[] | undefined;
}): string {
  if (a.code === UPSTREAM_UNAVAILABLE_CODE)
    return `${upstreamUnavailableNotice(a.retryAfterSec)}（这一笔已记为失败，额度已释放）`;
  const rows = refundsOf(a.order);
  const known = new Set(a.knownIds ?? []);
  const row =
    a.refundId !== undefined
      ? rows.find((r) => String(r.id) === a.refundId)
      : rows.filter((r) => !known.has(String(r.id))).at(-1);
  if (row === undefined) return '';
  switch (String(row.status)) {
    case 'failed':
      return '机构确认失败，额度已释放，可重新发起';
    case 'succeeded':
      return '刷新后这一笔已是「已退款」：实际已退成功，无需再操作';
    case 'pending':
      return '机构处理中：请稍后点「同步」取回结果，不要去 Stripe 后台重复退';
    default:
      return '结果未知，请点「同步」取回结果，不要去 Stripe 后台重复退';
  }
}

/**
 * 全额退款确认框的正文（严格检查 A-2，2026-10-10）：写**实际要退的钱**，不是订单合计。
 *
 * @why 原先固定写"合计 {total_jpy}"；服务端实退 = 原币实收 − 已成功部分退款（server/src/domain/partial-refund.ts
 *      `fullRefundAmount`）。先部分退过的单、美元付款的单，确认框里的数都是错的——而这是不可撤销的动作。
 * @why 只扣**已成功**的部分退款（与服务端同口径）；在途的那几笔服务端会直接拒全额退款（40902 partial_refund_in_flight），
 *      这里不替它猜。注意这与 `refundableMinor`（部分退款额度，扣掉一切未失败的）口径不同，刻意不复用。
 * @limitation 没有成功的支付记录（旧数据 / 详情没带 payments）时不编数字：写合计并说明以支付机构为准。
 */
export function fullRefundConfirmBody(order: unknown): string {
  const o = (order ?? {}) as { order_no?: unknown; order_id?: unknown };
  const no = typeof o.order_no === 'string' ? o.order_no : String(o.order_id ?? '');
  const amount = fullRefundAmountText(order);
  if (amount === FULLY_REFUNDED_TEXT) return `订单 ${no}：${amount}。`;
  return `订单 ${no}：${amount}。退款原因会记录下来。`;
}

const FULLY_REFUNDED_TEXT = '部分退款已退满实收，已无可退金额';

/**
 * 全额退款实际要退多少（一句话，不带单号）——抽屉里先写这一句，确认框也用它（全入口点击测试 2026-10-11）。
 * @why 抽屉原先只有原因与按钮，金额要回页面去找、到确认框才看到；两处同一个函数，不会写出两个数。
 */
export function fullRefundAmountText(order: unknown): string {
  const o = (order ?? {}) as { total_jpy?: unknown };
  const pays = (order as { payments?: unknown } | null)?.payments;
  const pay = (Array.isArray(pays) ? pays : []).find(
    (p: { status?: unknown }) => p?.status === 'succeeded',
  ) as { charge_currency?: unknown; charge_amount?: unknown } | undefined;
  if (
    pay === undefined ||
    !Number.isInteger(pay.charge_amount) ||
    typeof pay.charge_currency !== 'string'
  ) {
    return `合计 ${minorMoneyText(o.total_jpy, 'JPY')}（实际可退金额以支付机构为准）`;
  }
  const currency = pay.charge_currency;
  const charged = pay.charge_amount as number;
  const succeeded = refundsOf(order)
    .filter((r) => r.status === 'succeeded')
    .reduce((s, r) => s + (Number.isInteger(r.amount_minor) ? (r.amount_minor as number) : 0), 0);
  const refund = Math.max(0, charged - succeeded);
  if (refund === 0) return FULLY_REFUNDED_TEXT;
  const notes = [
    ...(succeeded > 0
      ? [
          `实收 ${minorMoneyText(charged, currency)}，已部分退 ${minorMoneyText(succeeded, currency)}`,
        ]
      : []),
    ...(currency.toUpperCase() !== 'JPY' ? ['按买家付款的币种退'] : []),
  ];
  return `将原路退回 ${minorMoneyText(refund, currency)}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`;
}

/** 同步后那一笔的状态 → 一句结果（与列表里的状态文案不同：这里是"刚刚查到了什么"）。 */
const SYNC_RESULT: Record<string, string> = {
  succeeded: '已退款',
  failed: '机构确认失败（未退，额度已释放）',
  pending: '仍在机构处理中，稍后再点「同步」',
  initiated: '仍在机构处理中，稍后再点「同步」',
  unknown: '结果仍未知，稍后再点「同步」',
};

/**
 * 点「同步」之后的提示（两端逐页走查第三轮 2026-10-12）：原先与新建共用"部分退款已提交…"——同步没有提交任何东西，要说查到的结果。
 * @param fresh 刷新后的订单；拿不到（刷新失败）→ 让运营看上方记录
 */
export function partialSyncNotice(fresh: unknown, refundId: string): string {
  const r = refundsOf(fresh).find((x) => String(x.id) === refundId);
  if (r === undefined) return '已同步，结果以上方记录为准';
  const amount = formatMinorCn(Number(r.amount_minor), String(r.currency));
  return `已同步：${amount}这笔${SYNC_RESULT[String(r.status)] ?? '状态已更新'}`;
}
