/**
 * 职责：客户页（AJ-404）的纯函数——列表行文案、短 id、统计卡片、风险文案、地址一行、列表查询串。
 *
 * @why 列表里的 id 只露前 8 位（`shortId`）：完整 id 是给"去运营日志按对象查"用的，列表里一整串 UUID
 *      只会把收件人、邮箱挤出视野；详情页仍给完整、可复制的 id。openid 服务端根本不下发。
 * @why 缺失一律显示占位（`—` / `（未下单）`），**不**显示成 0 或空串；金额 0 円只在服务端真给了 0 时出现。
 * @limitation 统计口径（排除测试单、累计不扣退款）在服务端（customers-admin.ts 文件头表），这里只负责转述；
 *             卡片副标题写明"不扣退款"，免得运营把它当净收入。
 * @see ./api.ts；../../../server/src/adapters/customers-admin.ts
 */
import { formatJst, moneyText } from '../format.js';

/** 契约 `AdminCustomerListItem`（前端只读用到的字段）。 */
export interface CustomerListItem {
  id: string;
  created_at?: string;
  blocked?: boolean;
  blocked_at?: string;
  order_count?: number;
  paid_order_count?: number;
  paid_total_jpy?: number;
  last_order_at?: string;
  contact_email?: string;
  last_recipient?: string;
}

export interface CustomerStatsLike {
  order_count?: number;
  paid_order_count?: number;
  paid_total_jpy?: number;
  test_order_count?: number;
  first_order_at?: string;
  last_order_at?: string;
}

export interface CustomerAddressLike {
  id?: string;
  recipient?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  is_default?: boolean;
}

export interface CustomerOrderLike {
  order_id: string;
  order_no?: string;
  status?: string;
  total_jpy?: number;
  is_test?: boolean;
  has_dispute?: boolean;
  created_at?: string;
  paid_at?: string;
}

/** 契约 `AdminCustomer`。 */
export interface CustomerDetailLike {
  id: string;
  created_at?: string;
  blocked?: boolean;
  blocked_at?: string;
  contact_email?: string;
  stats: CustomerStatsLike;
  addresses: CustomerAddressLike[];
  orders: CustomerOrderLike[];
  risk: { dispute_count?: number; open_dispute_count?: number };
}

/** 列表里的打码标识：`u-` 后只留 8 位。 */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

export interface CustomerRow {
  id: string;
  idText: string;
  name: string;
  email: string;
  ordersText: string;
  paidTotalText: string;
  lastOrderText: string;
  blocked: boolean;
}

/** `3 单 · 已付 2`：短、无括号，配合列表的 .cell-nowrap 一行放下（括号版在窄屏被拆成三行）。 */
function ordersText(total: number | undefined, paid: number | undefined): string {
  const n = total ?? 0;
  return n === 0 ? '0 单' : `${String(n)} 单 · 已付 ${String(paid ?? 0)}`;
}

export function customerRows(items: readonly CustomerListItem[]): CustomerRow[] {
  return items.map((c) => ({
    id: c.id,
    idText: shortId(c.id),
    name: c.last_recipient ?? '（未下单）',
    email: c.contact_email ?? '—',
    ordersText: ordersText(c.order_count, c.paid_order_count),
    paidTotalText: moneyText(c.paid_total_jpy),
    lastOrderText: formatJst(c.last_order_at),
    blocked: c.blocked === true,
  }));
}

/** 日期卡：`YYYY-MM-DD` 作大字，`HH:mm（日本时间）` 作小字；无值时大字 "—"、小字空。 */
function dateCard(label: string, iso: unknown): { label: string; value: string; sub: string } {
  const text = formatJst(iso);
  const [date = '', time = ''] = text.split(' ');
  return time === ''
    ? { label, value: text, sub: '' }
    : { label, value: date, sub: `${time}（日本时间）` };
}

export function statsCards(
  s: CustomerStatsLike,
): Array<{ label: string; value: string; sub: string }> {
  const tests = s.test_order_count ?? 0;
  return [
    {
      label: '订单数',
      value: `${String(s.order_count ?? 0)} 单`,
      sub: `已付款 ${String(s.paid_order_count ?? 0)} 单${tests > 0 ? `（另有测试单 ${String(tests)} 张，不计入）` : ''}`,
    },
    // 走查 2026-10-08："实付"会被读成已扣退款（实际不扣），改叫"累计付款"
    { label: '累计付款', value: moneyText(s.paid_total_jpy), sub: '已付款订单合计，不扣退款' },
    // 大字只放日期、时刻放小字：整串 "2026-10-08 02:19" 用大字号会被拆成两行（2026-10-09 浏览器验收）
    dateCard('首单', s.first_order_at),
    dateCard('最近下单', s.last_order_at),
  ];
}

export function riskText(c: Pick<CustomerDetailLike, 'blocked' | 'blocked_at' | 'risk'>): {
  text: string;
  danger: boolean;
} {
  const total = c.risk.dispute_count ?? 0;
  const open = c.risk.open_dispute_count ?? 0;
  const who = c.blocked === true ? `已拉黑（${formatJst(c.blocked_at)}）` : '未拉黑';
  const disputes =
    total === 0
      ? '无拒付记录'
      : open > 0
        ? `拒付 ${String(total)} 笔，进行中 ${String(open)} 笔`
        : `拒付 ${String(total)} 笔，均已结案`;
  // 全角括号后不再补半角空格（与订单详情等处的中文排版一致）
  const sep = who.endsWith('）') ? '· ' : ' · ';
  return { text: `${who}${sep}${disputes}`, danger: c.blocked === true || open > 0 };
}

/** 地址一行（电话另列；美式顺序：街道, 二行, 城市 州 邮编, 国家）。 */
export function addressLine(a: CustomerAddressLike): string {
  // 美国写法「城市, 州 邮编」（2026-10-12：原为 "New York NY 10118"，与小程序 / 打印页不一致）
  const stateZip = [a.state, a.postal_code].filter((x) => x !== undefined && x !== '').join(' ');
  const cityLine = [a.city, stateZip].filter((x) => x !== undefined && x !== '').join(', ');
  return [a.line1, a.line2, cityLine, a.country]
    .filter((x): x is string => x !== undefined && x !== '')
    .join(', ');
}

/** 列表查询串（空关键字 / 第 1 页不带，地址栏保持干净）。 */
export function customerListQuery(q: {
  keyword: string;
  page: number;
  /** 评估 4.5：`-paid_total_jpy` 之类；空 / 不传 = 默认（最近下单倒序）。 */
  sort?: string;
  /** 评估 4.6：每页条数；20（默认）不写。 */
  size?: number;
}): string {
  const p = new URLSearchParams();
  const kw = q.keyword.trim();
  if (kw !== '') p.set('keyword', kw);
  if (q.page > 1) p.set('page', String(q.page));
  if (q.sort !== undefined && q.sort !== '') p.set('sort', q.sort);
  if (q.size !== undefined && q.size !== 20) p.set('size', String(q.size));
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

/** 客户详情页拉黑的二次确认正文（与风控页同样写全后果；解除入口就在本页）。 */
export const CUSTOMER_BLOCK_CONFIRM_TEXT =
  '拉黑后：① 该客户不能再下单；② 其名下未付款的订单（待付款 / 支付中）会被立即取消、库存回补；③ 可在本页或「风控」页解除，但已取消的订单不会恢复。确认继续？';

/** 删除行为记录的二次确认正文（AJ-413）：说清删什么、不删什么、不可恢复。 */
export const CUSTOMER_PURGE_CONFIRM_TEXT =
  '只删除该客户在小程序里的浏览、加购、下单、支付等使用记录（隐私政策承诺的"用户要求即删除"）。订单、地址、退款与审计记录不受影响。删除后无法恢复；这次操作与原因会记录下来。';

/**
 * 订单页"只看这位客户"的称呼（全入口点击测试 2026-10-11）：默认地址收件人 > 第一个地址收件人 > 联系邮箱 > 空串。
 * @why 原先订单页写"只看这位客户：u-065bf2d9-7815-…"（36 位用户 id），运营认不出是谁；客户没有昵称，收件人名最能认出人。
 */
export function customerLabel(c: {
  addresses?: ReadonlyArray<CustomerAddressLike>;
  contact_email?: string | null;
}): string {
  const list = c.addresses ?? [];
  const pick = list.find((a) => a.is_default === true) ?? list[0];
  const name = (pick?.recipient ?? '').trim();
  if (name !== '') return name;
  return (c.contact_email ?? '').trim();
}
