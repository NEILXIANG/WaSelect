/**
 * 职责：订单管理的**视图纯函数**（列表行 / 三个操作的闸门 / 请求体 / 展示文案）。
 *
 * @why 与 `products/view.ts` 同一条纪律：vitest 的 unit 层是 node 环境，
 *      没有 jsdom 也没有组件测试 harness，逻辑写在 `.tsx` 里就只能靠人肉点。
 *
 * @why **前端要重复一遍"能不能点"的判断**（发货 / 退款 / 改址）：
 *      这三个按钮点了之后是**不可逆的资金或物流动作**——
 *      "未付款就发货"发出去的是货，"已退款再退款"打出去的是第二笔钱。
 *      让运营点了才知道不能做，等于把服务端 409 当成交互设计。
 *      ⚠️ 服务端仍是权威（契约写明 409 / 40907）：这里是**预检**不是放行，
 *      两处口径由单测与契约的双向比对钉住。
 *
 * @limitation 一：**状态文案另有一份**，不直接用 shared 的 `ORDER_STATUS_DISPLAY`。
 *              那份是给**买家**看的（created / pending_payment 都显示"待付款"，
 *              delivered / completed 都显示"已签收"）；管理端要区分十态——
 *              客服说"待付款"时得知道是"没发起"还是"支付中"，否则会对客户说错话。
 *              两份文案的**键集合**由单测与契约 `OrderStatus` enum 双向比对，防键漂移。
 * @limitation 二：`has_dispute` 只有 `GET /admin/orders/{id}`（AdminOrder）才返回，
 *              **列表接口（Order）没有这个字段**。所以 `refundGate` 对"字段缺失"的处理是
 *              **放行**（不是拦）：拦了会让正常订单点不动，而真正的拦截由服务端 40907 兜住。
 *              这个不对称是契约形状决定的，将来列表补上该字段，这里应改成一律拦。
 * @limitation 三：时间恒显 **JST**（+09:00），不跟随浏览器时区——
 *              管理员出差、或运营用海外 IP 登录时，本地时区会把"下单时间"整体错开几小时，
 *              而客服是拿这个时间跟客户对口径的。
 *
 * @see ../../../contracts/api-contract.yaml（OrderStatus / Order / AdminOrder / ship / refund）；
 *      packages/shared/src/enums.ts（ORDER_STATUS 真源）；../../../docs/自主决策记录.md
 */
import { ORDER_STATUS, type OrderStatus } from '@waselect/shared';

/** 管理端状态文案（@see @limitation 一：比买家侧更细，十态互不合并）。 */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  created: '待付款（未发起）',
  pending_payment: '待付款（支付中）',
  paid: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  refunding: '退款中',
  refunded: '已退款',
};

/** 筛选下拉的选项（`all` 是前端概念：服务端不传 status 即不过滤）。 */
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{
  value: OrderStatus | 'all';
  label: string;
}> = [
  { value: 'all', label: '全部' },
  ...ORDER_STATUS.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] })),
];

/** 闸门结果：不能操作时必须有**具体原因**（按钮禁用也要能 tooltip 出来）。 */
export interface Gate {
  ok: boolean;
  reason: string;
}

const OK: Gate = { ok: true, reason: '' };
const NO = (reason: string): Gate => ({ ok: false, reason });

/** 列表行视图。 */
export interface OrderRow {
  id: string;
  orderNo: string;
  /** null = 服务端给了契约外的状态（不猜：猜了就会显示成某个真实状态）。 */
  status: OrderStatus | null;
  statusText: string;
  totalText: string;
  createdText: string;
  recipientText: string;
  /** 承运商 + 运单号（未发货时为空串）。 */
  shipText: string;
  hasDispute: boolean;
  isTest: boolean;
  actions: { ship: Gate; refund: Gate; address: Gate };
}

/** 千分位（不用 toLocaleString：它跟随浏览器语言区，同一笔钱两台机器显示不一样）。 */
export function moneyText(jpy: unknown): string {
  if (!Number.isInteger(jpy)) return '—';
  return `${String(jpy).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} 円`;
}

/**
 * ISO 时间 → `YYYY-MM-DD HH:mm`（JST，@see @limitation 三）。
 * @tradeoff 这里用了 `Date.parse` 与 `Date` 构造器：F10 的"禁 `new Date()`"针对的是
 *           **业务判定**（到期、TTL、账期），展示层的时区换算没有第二条实现路径
 *           （除非引入日期库），收益不抵依赖。换算后仍走 `toISOString()` 取值，
 *           所以结果**不依赖运行机器的时区**——单测可以钉死。
 */
export function formatOrderTime(iso: unknown): string {
  if (typeof iso !== 'string' || iso === '') return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 从任意形状里读状态（契约外的值返回 null，由调用方决定怎么显示）。 */
function readStatus(value: unknown): OrderStatus | null {
  const s = (value as { status?: unknown } | null)?.status;
  return typeof s === 'string' && (ORDER_STATUS as readonly string[]).includes(s)
    ? (s as OrderStatus)
    : null;
}

function readString(value: unknown, key: string): string {
  const v = (value as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
}

/** `Order[]` / `AdminOrder[]` → 列表行。 */
export function orderRows(items: unknown): OrderRow[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .filter((o) => typeof o['order_id'] === 'string' && o['order_id'] !== '')
    .map((o) => {
      const status = readStatus(o);
      const carrier = readString(o, 'carrier');
      const tracking = readString(o, 'tracking_no');
      return {
        id: o['order_id'] as string,
        orderNo: readString(o, 'order_no'),
        status,
        statusText: status === null ? '未知状态' : ORDER_STATUS_LABELS[status],
        totalText: moneyText(o['total_jpy']),
        createdText: formatOrderTime(o['created_at']),
        recipientText: readString(
          (o['address'] as Record<string, unknown> | null) ?? {},
          'recipient',
        ),
        shipText:
          carrier === '' && tracking === ''
            ? ''
            : [carrier, tracking].filter((s) => s !== '').join(' / '),
        hasDispute: o['has_dispute'] === true,
        isTest: o['is_test'] === true,
        actions: { ship: shipGate(o), refund: refundGate(o), address: addressGate(o) },
      };
    });
}

/**
 * 发货闸门：只有 `paid` 能发货（契约 `/admin/orders/{id}/ship` 的 409 口径）。
 *
 * @limitation 四：`has_dispute=true` 时**这里也拦发货**，但契约只在退款处写了 40907
 *               ——服务端目前并不阻止"拒付进行中照常发货"。
 *              拦的理由是业务不是契约：拒付还在争议就发货，赢了拿回钱、输了钱货两空。
 *              ⚠️ 这是**前端单边口径**，若将来服务端明确允许拒付中发货，这里要跟着改，
 *              否则会出现"服务端放行、前端点不动"的不一致。
 */
export function shipGate(order: unknown): Gate {
  const status = readStatus(order);
  if (status === null) return NO('订单状态未知，不能操作');
  if ((order as { has_dispute?: unknown } | null)?.has_dispute === true)
    return NO('有拒付进行中，先处理拒付再发货（发货后钱货两空）');
  switch (status) {
    case 'paid':
      return OK;
    case 'created':
    case 'pending_payment':
      return NO('未付款，不能发货');
    case 'shipped':
    case 'delivered':
      return NO('已发货，不能重复发货');
    case 'completed':
      return NO('已完成，不能发货');
    case 'refunding':
      return NO('退款中，不能发货');
    case 'refunded':
      return NO('已退款，不能发货');
    case 'cancelled':
      return NO('已取消，不能发货');
    case 'expired':
      return NO('已过期，不能发货');
  }
}

/**
 * 退款闸门（全额退款，MVP）。
 *
 * @why `created` / `pending_payment` 给的是"去取消"而不是"去退款"：
 *      没付过的钱没有可退的支付记录，走退款只会拿到 409，
 *      而运营真正要做的是取消订单——文案不指明这一点，他会反复点退款。
 * @limitation 五：`completed`（已完成）**前端拦**，理由是 MVP 只支持全额退款、
 *      完成单的退款需要线下处理；契约本身没有把 completed 排除在外，
 *      所以这条同样是前端口径，服务端将来若支持应同步放开。
 */
export function refundGate(order: unknown): Gate {
  const status = readStatus(order);
  if (status === null) return NO('订单状态未知，不能操作');
  if ((order as { has_dispute?: unknown } | null)?.has_dispute === true)
    return NO('有拒付进行中，退款会被拒（40907）；请先在拒付列表处理');
  switch (status) {
    case 'paid':
    case 'shipped':
    case 'delivered':
      return OK;
    case 'created':
    case 'pending_payment':
      return NO('未付款，请取消订单而不是退款');
    case 'refunding':
      return NO('退款已在处理中，不要重复提交');
    case 'refunded':
      return NO('已退款');
    case 'completed':
      return NO('已完成，MVP 不支持完成后退款（走线下处理）');
    case 'cancelled':
      return NO('已取消，未成交无需退款');
    case 'expired':
      return NO('已过期，未成交无需退款');
  }
}

/** 改址闸门：契约写明"仅 paid 未发货"。 */
export function addressGate(order: unknown): Gate {
  const status = readStatus(order);
  if (status === null) return NO('订单状态未知，不能操作');
  if (status === 'paid') return OK;
  return NO(`仅"待发货"可改址（当前：${ORDER_STATUS_LABELS[status]}）——已发货改址要联系承运商`);
}

/**
 * 订单地址 → 一行文案（空段跳过，防止出现"Seattle，，WA"）。
 *
 * @why 放进 view 而不是写在 `.tsx` 里：那是**字符串拼装逻辑**，
 *      写在组件里就进不了门禁（tsx 不收覆盖率、也没有组件测试 harness），
 *      而它错的样子恰恰是"看一眼像对的"——多一个空逗号没人会发现。
 */
export function addressSummary(order: unknown): string {
  const addr = (order as { address?: unknown } | null)?.address;
  const o = (typeof addr === 'object' && addr !== null ? addr : {}) as Record<string, unknown>;
  const parts = ['recipient', 'line1', 'line2', 'city', 'state', 'postal_code']
    .map((k) => (typeof o[k] === 'string' ? (o[k] as string).trim() : ''))
    .filter((s) => s !== '');
  return parts.length === 0 ? '—' : parts.join('，');
}

/** 支付信息 → 一行文案（取 `payment.channel` 与原币扣款额，缺则占位）。 */
export function paymentSummary(order: unknown): string {
  const p = (order as { payment?: unknown } | null)?.payment;
  const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
  const channel = typeof o['channel'] === 'string' ? o['channel'] : '';
  const currency = typeof o['charge_currency'] === 'string' ? o['charge_currency'] : '';
  const amount = Number.isInteger(o['charge_amount']) ? String(o['charge_amount']) : '';
  const text = [channel, [currency, amount].filter((s) => s !== '').join(' ')]
    .filter((s) => s !== '')
    .join(' · ');
  return text === '' ? '—' : text;
}

/** 发货表单（契约 `required: [carrier, tracking_no]`）。 */
export interface ShipForm {
  carrier: string;
  trackingNo: string;
}

export function emptyShipForm(): ShipForm {
  return { carrier: '', trackingNo: '' };
}

/** 发货校验（与 `products` 同口径：一次返回全部错误，不留着让运营一条条试）。 */
export function shipErrors(form: unknown): {
  ok: boolean;
  errors: Record<string, string>;
  first: string;
} {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const carrier = typeof f['carrier'] === 'string' ? f['carrier'].trim() : '';
  const trackingNo = typeof f['trackingNo'] === 'string' ? f['trackingNo'].trim() : '';
  const errors: Record<string, string> = {};
  if (carrier === '') errors['carrier'] = '承运商必填';
  if (trackingNo === '') errors['trackingNo'] = '运单号必填';
  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/** 表单 → 契约请求体（键名是服务端的 `tracking_no`，不是表单的 `trackingNo`）。 */
export function toShipBody(form: unknown): { carrier: string; tracking_no: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  return {
    carrier: typeof f['carrier'] === 'string' ? f['carrier'].trim() : '',
    tracking_no: typeof f['trackingNo'] === 'string' ? f['trackingNo'].trim() : '',
  };
}

/** 退款表单（契约 `required: [reason]`）。 */
export interface RefundForm {
  reason: string;
}

export function emptyRefundForm(): RefundForm {
  return { reason: '' };
}

/**
 * 退款校验。
 * @why reason 只要求非空、不设最短长度：退款原因是要进审计台账给人看的，
 *      "缺货""客户取消"四个字就够；设了最短长度只会逼人填满 `aaaa`。
 */
export function refundErrors(form: unknown): { ok: boolean; first: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const reason = typeof f['reason'] === 'string' ? f['reason'].trim() : '';
  return reason === ''
    ? { ok: false, first: '退款原因必填（会进审计台账）' }
    : { ok: true, first: '' };
}

/** 表单 → 契约请求体。 */
export function toRefundBody(form: unknown): { reason: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  return { reason: typeof f['reason'] === 'string' ? f['reason'].trim() : '' };
}
