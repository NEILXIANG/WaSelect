/**
 * 职责：订单管理的**视图纯函数**（列表行 / 三个操作的闸门 / 请求体 / 展示文案）。
 *
 * @why 与 `products/view.ts` 同一条纪律：逻辑抽成**纯函数**才能用**边界表**钉住——
 *      订单状态 × 三个不可逆动作的组合有几十种，写在 `.tsx` 里每改一次都要人肉点一遍，
 *      而这类组合错的表现恰恰是"该灰的按钮没灰"（点了才知道 = 把服务端 409 当交互设计）。
 *      ⚠️ 2026-10-01 订正（ADM3-07）：这里原写"unit 层是 node 环境、没有 jsdom 也没有组件测试
 *      harness"——`admin-web/src/testing/dom.ts` 落地后 jsdom 组件用例已可跑（`*.dom.unit.test.ts`），
 *      那句已不是事实。真实的理由仍是成本：组件用例要挂载、要等异步、断言还依赖 DOM 结构，
 *      而"输入 → 允许/不允许"的判定写成表格就是几行。**结论（逻辑放 view）不变，理由换成真的**。
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
 * @limitation 二：`has_dispute` **列表与详情都有**（契约 0.6.1 起 `AdminOrderListItem` 带上它，
 *              此前只有 `AdminOrder` 有）。但 `refundGate` 对"字段缺失"的处理**仍是放行**（不是拦）：
 *              拦了会让正常订单点不动，而真正的拦截由服务端 40907 兜住；
 *              放行则最坏是"点了才看到服务端报错"，比"整片订单点不动"轻。
 *              ⚠️ 这条是**防御**，不是"预期会缺失"：正常路径下字段一定在
 *              （@see ../orders/api.ts @limitation 三）。契约再变一次时它也是安全的一侧。
 * @limitation 三：时间恒显 **JST**（+09:00），不跟随浏览器时区——
 *              管理员出差、或运营用海外 IP 登录时，本地时区会把"下单时间"整体错开几小时，
 *              而客服是拿这个时间跟客户对口径的。
 *
 * @see ../../../contracts/api-contract.yaml（OrderStatus / Order / AdminOrder / ship / refund）；
 *      packages/shared/src/enums.ts（ORDER_STATUS 真源）；../../../docs/自主决策记录.md
 */
import {
  ADMIN_NOTE_MAX_LENGTH,
  ORDER_STATUS,
  REFUND_REASON_MAX_LENGTH,
  SHIP_MAX_CHARS,
  type OrderStatus,
} from '@waselect/shared';
import { UPSTREAM_UNAVAILABLE_CODE } from '../api/errors.js';
import { formatJst, minorMoneyText, moneyText } from '../format.js';

/** 管理端状态文案（@see @limitation 一：比买家侧更细，十态互不合并）。 */
// AJ-494：词表挪到 shared（服务端导出订单总表也用它），这里原样转出，调用方不用改
import { ORDER_STATUS_LABELS } from '@waselect/shared';
export { ORDER_STATUS_LABELS };

// 状态筛选的选项已由 ./list-filter.ts 的 STATUS_TABS 取代（AJ-400：下拉改页签，页签覆盖十态由其单测钉住）。

/**
 * 事件流里**不是订单状态**的伪状态文案（只出现在管理端）。
 *
 * @why `order_events.status` 是 VARCHAR：它既存订单状态（`ORDER_STATUS` 十态），
 *      也存"没迁状态、只记下发生过一件事"的伪状态（改址 / 拒付 / 退款失败……）。
 *      管理端详情页此前直接显示 `status` 原文，于是这些英文**原样**出现在运营眼前——
 *      而管理端是中文界面，且这几行恰恰是运营最需要读懂的（"这张单的退款失败过"）。
 * @why 键不抽成服务端常量：这些串分散在 `adapters/orders-admin.ts`、
 *      `app/mark-disputed.ts`、`app/payment-intent.ts` 三处的 SQL 字面量里，
 *      抽常量要动服务端；前端这一份只是**文案层**的映射，
 *      服务端新增一种事件时这里漏配的后果是"那一行显示英文"（看得见），
 *      不是"信息被吃掉"（见 @limitation）。
 *
 * @limitation 认不出的值**原样返回**，不映射成"未知"：
 *      新增一种管理事件而这里没跟上时，原样显示至少还留着服务端那个可检索的串；
 *      映射成"未知状态"会把"发生过什么事"这层信息直接抹掉——那是静默丢信息。
 */
/**
 * 时间线里订单状态的**事件词**（全入口点击测试 2026-10-11）。
 * @why 时间线讲"那时发生了什么"；原先直接用状态词，付款那一行写"待发货 · 支付机构 mock"，读成"支付机构待发货"。
 *      页面状态格仍用 `ORDER_STATUS_LABELS`（状态词），时间线用这张（事件词）。
 */
export const ORDER_EVENT_LABELS: Readonly<Record<OrderStatus, string>> = {
  created: '下单（等待买家付款）',
  pending_payment: '发起付款', // 不写"买家"：后面紧跟操作人「· 买家」（业务旅程测试 2026-10-12）
  paid: '付款成功（待发货）',
  shipped: '已发货',
  delivered: '已签收',
  completed: '交易完成',
  cancelled: '订单取消',
  expired: '超时未付款，订单关闭',
  refunding: '开始退款',
  refunded: '退款完成',
};

export const EVENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  address_changed: '改址',
  dispute_opened: '拒付开案',
  dispute_closed: '拒付结案',
  refund_pending: '退款处理中',
  refund_failed: '退款失败',
  dispute_released: '解除拒付限制',
  pay_create_failed: '机构拒建支付会话',
  late_paid: '迟到付款（关单后收到钱）',
  // AJ-383 部分退款的两条事件（server/src/app/partial-refund.ts）；第三轮缺口 P2-50 补
  partial_refunded: '部分退款成功',
  partial_failed: '部分退款失败',
  // 三端联动模拟 2026-10-08：这三条原先原样显示英文
  shipment_fixed: '改运单号',
  // AJ-440：撤销发货（note 里有原运单号与原因）
  shipment_reverted: '撤销发货',
  // AJ-452：处理售后（note = 结果：说明（售后 #id））
  after_sale_handled: '处理售后',
  refunded_by_parts: '部分退款已退满',
  test_archived: '测试单归档',
};

/**
 * 事件行的操作者文案（ADM-1 / AJ-466）：服务端一直写全了 actor，前端此前不渲染——
 * "谁写了备注"看得见、"谁发的货 / 谁退的款"看不见，资金操作反而不可追溯。
 * - `admin:<id>` → 邮箱（详情接口 0.6.68 起按 id 回填 `actor_email`）；没有邮箱时显示原串，至少可检索；
 * - `provider:<name>` → 支付机构；`job:*` / `system` / `cli:*` → 系统；`user:*` → 买家；
 * - 没有 actor（早期事件）→ 空串，不编。
 */
export function eventActorText(
  e: { actor?: unknown; actor_email?: unknown },
  channelLabels: Readonly<Record<string, string>> = {},
): string {
  if (typeof e.actor_email === 'string' && e.actor_email !== '') return e.actor_email;
  const a = typeof e.actor === 'string' ? e.actor : '';
  if (a === '') return '';
  if (a.startsWith('admin:')) return a;
  // 全入口点击测试 2026-10-11：通道写中文名（channel-labels.ts，取设置接口）；认不出的原样显示代号
  if (a.startsWith('provider:')) {
    const code = a.slice('provider:'.length);
    return `支付机构 ${channelLabels[code] ?? code}`;
  }
  if (a.startsWith('user:') || a === 'buyer') return '买家';
  return '系统';
}

/** 闸门结果：不能操作时必须有**具体原因**（按钮禁用也要能 tooltip 出来）。 */
export interface Gate {
  ok: boolean;
  reason: string;
}

const OK: Gate = { ok: true, reason: '' };
const NO = (reason: string): Gate => ({ ok: false, reason });
/** 部分退款的在途状态（与 partial-refund-view.ts IN_FLIGHT 同一组）。 */
const REFUND_IN_FLIGHT: ReadonlySet<string> = new Set(['initiated', 'pending', 'unknown']);

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
  /** 官方查件链接（认不出承运商 / 未发货 → 空串）。 */
  trackingUrl: string;
  /** 采购信息（每个行项目一行；空数组 = 服务端没给 items，列表显示"—"）。 */
  purchaseLines: string[];
  /** 每个行项目的"中文名 × 件数"（与 purchaseLines 同序）。 */
  itemNames: string[];
  hasDispute: boolean;
  isTest: boolean;
  /** AJ-425：有进行中的售后申请 / 下单用户已被拉黑（列表徽章用；字段缺失按 false）。 */
  afterSaleOpen: boolean;
  userBlocked: boolean;
  actions: { ship: Gate; refund: Gate; address: Gate };
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

/**
 * 订单状态 → 中文文案；契约外 / 缺失 → `未知状态`（**不猜**成某个真实状态）。
 *
 * @why 抽成函数而不是让调用处自己写 `status === null ? '未知状态' : LABELS[status]`：
 *      L4 浏览器验收（2026-10-02）发现订单详情页的「状态」与「事件」两处**直接渲染
 *      服务端原文**（`created` / `paid` / `shipped`），而列表页用的是中文词表——
 *      同一个状态在列表页叫「待发货」、在详情页叫 `paid`。根因就是这句三元表达式
 *      **只写在 `orderRows` 内部**，详情页拿不到，于是照抄了 `order.status`。
 *      抽出来之后，"状态怎么显示"只有一处答案，两处都调它。
 */
export function statusText(order: unknown): string {
  const status = readStatus(order);
  return status === null ? '未知状态' : ORDER_STATUS_LABELS[status];
}

/**
 * 事件流一行的状态文案：订单状态走 {@link ORDER_STATUS_LABELS}，
 * 伪状态走 {@link EVENT_STATUS_LABELS}，其余**原样返回**（见它的 @limitation）。
 */
export function eventStatusText(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  if ((ORDER_STATUS as readonly string[]).includes(raw)) {
    return ORDER_EVENT_LABELS[raw as OrderStatus];
  }
  return EVENT_STATUS_LABELS[raw] ?? raw;
}

/** 部分退款失败事件 note 里的原因码 → 中文（server/src/app/partial-refund.ts 只写了这一种）。 */
const PARTIAL_FAIL_REASONS: Readonly<Record<string, string>> = {
  provider_failed: '支付机构确认失败',
};

/**
 * 服务端写死的英文备注 → 中文（三端联动模拟 2026-10-10）。键是"事件状态 + 备注原文"，只认对应事件：
 * 同样的字样出现在运营手写的备注里（别的事件）不翻，不改人写的字。
 * 来源：confirm-receipt-routes.ts（buyer_confirmed）、partial-refund.ts（refunded_by_parts 迁 refunding / refunded）。
 * @limitation 服务端新增写死的英文备注不会自动进这张表——时间线上会原样露出（宁可难看，不吞信息）。
 */
const FIXED_EVENT_NOTES: Readonly<Record<string, string>> = {
  'delivered|buyer_confirmed': '买家确认收货',
  'refunding|refunded_by_parts': '部分退款累计已退满整单',
  'refunded|refunded_by_parts': '部分退款累计已退满整单',
};

/** auto-fulfilment.ts 的 `auto:{N}d`：按天数自动签收 / 自动完成。 */
const AUTO_ADVANCE_NOTES: Readonly<Record<string, (days: string) => string>> = {
  delivered: (d) => `发货满 ${d} 天买家未确认，系统自动签收`,
  completed: (d) => `签收满 ${d} 天，系统自动完成`,
};

/**
 * 事件流一行的**备注**文案：部分退款几条事件的 note 是服务端拼的机器串，翻成人话（验收 2026-10-08）。
 *
 * 形状（server/src/app/partial-refund.ts）：
 *   - `partial_refunded`：`{refundId}:{币种}:{最小单位金额}` → `500 日元` / `$12.34`
 *   - `partial_failed`：`{refundId}:{原因码}` → `支付机构确认失败`
 *   - `refunded_by_parts`：`{币种}:{累计最小单位金额}` → `累计 13,750 日元`
 *
 * @why 退款编号（rf-…）挪到 `ref`：主文案里一串 uuid 盖过了金额；排查时仍要它，所以由调用方放进 title 悬停可见。
 * @limitation 形状认不出（服务端改了拼法）→ **原样返回**，与 eventStatusText 同口径：宁可难看，不吞信息。
 */
export function eventNoteView(status: unknown, note: unknown): { text: string; ref: string } {
  const raw = typeof note === 'string' ? note : '';
  const fixed = typeof status === 'string' ? FIXED_EVENT_NOTES[`${status}|${raw}`] : undefined;
  if (fixed !== undefined) return { text: fixed, ref: '' };
  const auto = /^auto:(\d+)d$/.exec(raw);
  const autoText = typeof status === 'string' ? AUTO_ADVANCE_NOTES[status] : undefined;
  if (auto !== null && autoText !== undefined) return { text: autoText(auto[1] ?? ''), ref: '' };
  if (status === 'partial_refunded') {
    const m = /^(.+):([A-Za-z]{3}):(-?\d+)$/.exec(raw);
    const money = m === null ? '—' : minorMoneyText(Number(m[3]), m[2]);
    if (m !== null && money !== '—') return { text: money, ref: m[1] ?? '' };
  }
  if (status === 'partial_failed') {
    const i = raw.lastIndexOf(':');
    if (i > 0) {
      const reason = raw.slice(i + 1);
      return { text: PARTIAL_FAIL_REASONS[reason] ?? reason, ref: raw.slice(0, i) };
    }
  }
  // 三端模拟测试 2026-10-11：处理售后的 note 结尾是「（售后 #uuid）」（after-sale-routes.ts 拼的；事件表只追加、改不了历史），
  //   一串 36 位 id 跟在说明后面运营读不懂——挪进 ref（悬停可见），正文只留结果与说明
  if (status === 'after_sale_handled') {
    const m = /^([\s\S]*)（售后 #([^）]+)）$/.exec(raw);
    if (m !== null) return { text: m[1] ?? '', ref: m[2] ?? '' };
  }
  // 迟到付款 / 已退款的 note 是支付机构流水号（mark-paid.ts / 退款落账写的），一整串机器号进正文运营读不懂——挪进 ref。
  //   只认"不含空白与中文的单个长串"：人写的退款原因照常显示
  if (
    (status === 'late_paid' || status === 'refunded') &&
    /^[\w.:-]{8,}$/.test(raw) &&
    /\d/.test(raw)
  ) {
    return { text: '', ref: raw };
  }
  if (status === 'refunded_by_parts') {
    const m = /^([A-Za-z]{3}):(-?\d+)$/.exec(raw);
    const money = m === null ? '—' : minorMoneyText(Number(m[2]), m[1]);
    if (money !== '—') return { text: `累计 ${money}`, ref: '' };
  }
  return { text: raw, ref: '' };
}

/** 时间线悬停里 ref 的名字（eventNoteView 挪进 ref 的东西不止退款编号）。 */
export function eventRefLabel(status: unknown): string {
  if (status === 'after_sale_handled') return '售后编号';
  if (status === 'late_paid') return '支付流水号';
  if (status === 'refunded') return '退款流水号';
  return '退款编号';
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
        statusText: statusText(o),
        totalText: moneyText(o['total_jpy']),
        createdText: formatJst(o['created_at']),
        // 列表行带顶层 `recipient`（0.6.9/KD-14）；详情形状（AdminOrder）只有 address.recipient——两种都认
        recipientText:
          readString(o, 'recipient') ||
          readString((o['address'] as Record<string, unknown> | null) ?? {}, 'recipient'),
        shipText:
          carrier === '' && tracking === ''
            ? ''
            : [carrier, tracking].filter((s) => s !== '').join(' / '),
        // 剩余清单 3-5：服务端生成的官方查件链接；只收 https（不把脏值渲染成可点链接）
        trackingUrl: readString(o, 'tracking_url').startsWith('https://')
          ? readString(o, 'tracking_url')
          : '',
        purchaseLines: purchaseLines(o),
        itemNames: itemNames(o),
        hasDispute: o['has_dispute'] === true,
        isTest: o['is_test'] === true,
        afterSaleOpen: o['after_sale_open'] === true,
        userBlocked: o['user_blocked'] === true,
        actions: { ship: shipGate(o), refund: refundGate(o), address: addressGate(o) },
      };
    });
}

/**
 * 发货闸门：只有 `paid` 能发货（契约 `/admin/orders/{id}/ship` 的 409 口径）。
 *
 * @limitation 四：`has_dispute=true` 时**这里也拦发货**，与服务端 shipGuard 同口径
 *               （40909 dispute_open，AJ-145；契约 `/admin/orders/{id}/ship` 已写明）。
 *              含义是"有未解除的拒付限制"：进行中或已败诉（AJ-176 ⑧，lost 保持 has_dispute）。
 *              拦的理由：拒付还在争议就发货，赢了拿回钱、输了钱货两空。
 *              （复核 2026-10-06：原写"前端单边口径、服务端不拦"，AJ-145 起已不成立。）
 */
export function shipGate(order: unknown): Gate {
  const status = readStatus(order);
  if (status === null) return NO('订单状态未知，不能操作');
  // 与服务端 shipGuard 同口径（AJ-179）：审核期测试单是"未付款即确认"的，发货 = 真货换假钱
  if ((order as { is_test?: unknown } | null)?.is_test === true)
    return NO('审核期测试单，不得采购发货');
  // 已败诉同样锁着（has_dispute 两者都是 true，规律排查 2026-10-12）：按服务端的 payment_dispute 分开说，
  //   看不出是哪种时（旧服务端 / 缺字段）写两种都对的说法
  const dispute = disputeLockState(order);
  if (dispute === 'open') return NO('有拒付进行中，先处理拒付再发货（发货后钱货两空）');
  if (dispute === 'lost') return NO('拒付已败诉（货款已被银行退回买家），不能发货');
  if (dispute === 'locked') return NO('有拒付限制（进行中或已败诉），不能发货（发货后钱货两空）');
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
 * @limitation 五：`completed`（已完成）**全额退款入口**前端拦——售后退款走「部分退款」
 *      （AJ-383：订单状态不动，可退到全额）。原文案"MVP 不支持完成后退款（走线下处理）"
 *      在 AJ-383 之后已不成立（第三轮缺口 P2-50 订正）。
 */
export function refundGate(order: unknown): Gate {
  const status = readStatus(order);
  if (status === null) return NO('订单状态未知，不能操作');
  // ⚠️ 顺序与服务端 refundGuard 一致（A-01）：`refunding` 先于拒付判断。
  //    拒付期间再点只会查询在途那笔或同键重放，不会动第二笔钱；"换新键重新发起"由服务端拦。
  //    先判拒付的旧写法会把 refunding + 拒付 的单永久锁在退款中。
  const disputed = (order as { has_dispute?: unknown } | null)?.has_dispute === true;
  if (disputed && status !== 'refunding') return NO(disputeRefundBlockedText(order));
  // 迟到付款（剩余清单 1-5）：已关单收到了钱，服务端凭 late_paid 放行；与服务端 refundGuard 同口径
  // G1（AJ-456）：有一笔部分退款在途（服务端会 40902 partial_refund_in_flight）——先去部分退款面板点「同步」
  const partials = (order as { partial_refunds?: unknown } | null)?.partial_refunds;
  if (
    Array.isArray(partials) &&
    partials.some((p: { status?: unknown }) => REFUND_IN_FLIGHT.has(String(p?.status)))
  ) {
    return NO('有一笔部分退款还在处理中：先到「部分退款」点「同步」拿到结果，再决定是否整单退款');
  }
  const latePaid = (order as { late_paid?: unknown } | null)?.late_paid === true;
  if (latePaid && (status === 'expired' || status === 'cancelled')) {
    return {
      ok: true,
      reason:
        '订单关闭后才收到这笔钱（迟到付款），需全额退回给买家；退款不会回补库存（关单时已回补）',
    };
  }
  switch (status) {
    case 'paid':
    case 'shipped':
    case 'delivered':
      return OK;
    case 'created':
    case 'pending_payment':
      return NO('未付款，请取消订单而不是退款');
    case 'refunding':
      // KD-4 / KD-12（AJ-175）：服务端允许对停在 refunding 的单**再调一次**——
      // 这里曾写"不要重复提交"把按钮禁掉，服务端的修复在界面上没有入口，卡住的单只能找开发改库。
      // ⚠️ 文案必须**照契约 0.6.11 / F-03（AJ-178）的三种情形**说，不能一律说"重试"：
      //    ① 上一笔**在途**（refund_pending）→ 再调**只查询**该笔结果，不会再发起；
      //    ② 上一笔机构**确认失败** → 换新机构幂等键**重新发起**（所以不是"同一键不会退两次"）；
      //    ③ 结果**未知**（超时 / 机构报错）→ 沿用同一键重发，机构侧不会退两次。
      //    旧文案"同一幂等键不会退两次"只覆盖③，运营照它理解②会以为"再点也白点"，
      //    而②恰恰是**必须再点**的那一种（B41 / AJ-215）。
      //    MVP 前端拿不到"上一笔是哪一种"（详情里没有该字段），所以这里给**覆盖三种**的说法，
      //    并把"退款原因沿用首次"这句去掉——② 换新键时原因仍沿用，但"沿用原因"不是运营要做的判断。
      return {
        ok: true,
        reason: disputed
          ? '上一笔退款尚未确认完成，且期间有拒付。可再提交一次：只会查询上一笔的结果或用同一键重发；若上一笔确认失败，因有拒付不会重新发起'
          : '上一笔退款尚未确认完成（机构处理中 / 失败 / 结果未知）。可再提交一次：服务端会先查询上一笔的结果，确认失败才重新发起，不会重复退两次',
      };
    case 'refunded':
      return NO('已退款');
    case 'completed':
      return NO('已完成的订单请用操作条里的「部分退款…」处理售后（可退到全额）');
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
  const base = `仅"待发货"可改址（当前：${ORDER_STATUS_LABELS[status]}）`;
  // 只有已发货的单"联系承运商"才是下一步；已退款 / 超时关闭的单写这句是误导（业务旅程测试 2026-10-12）
  return NO(status === 'shipped' ? `${base}——已发货改址要联系承运商` : base);
}

/**
 * 订单地址 → 一行文案（空段跳过，防止出现"Seattle，，WA"）。
 *
 * @why 放进 view 而不是写在 `.tsx` 里：那是**字符串拼装逻辑**，
 *      写成纯函数可以直接断言"多一个空逗号"这种边界——它错的样子恰恰是"看一眼像对的"。
 *      ⚠️ 2026-10-01 订正（ADM3-07）：原写"tsx 不收覆盖率、也没有组件测试 harness"，
 *      后半句已不成立（`testing/dom.ts` 已可挂组件，本目录就有 `*.dom.unit.test.ts`）；
 *      前半句仍是当前口径但理由要写准：`.tsx` **不进覆盖率统计**是刻意的
 *      （@see vitest.coverage-gates.ts：组件用例断言依赖 DOM 结构，收进来会让阈值被 DOM 改动牵着走），
 *      不是"测不了"。
 */
export function addressSummary(order: unknown): string {
  const addr = (order as { address?: unknown } | null)?.address;
  const o = (typeof addr === 'object' && addr !== null ? addr : {}) as Record<string, unknown>;
  const t = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  // 美国写法「城市, 州 邮编」，英文逗号（两端逐页走查 2026-10-12：原用中文逗号，与客户页 / 打印面单不一致）
  const stateZip = [t('state'), t('postal_code')].filter((s) => s !== '').join(' ');
  const parts = [t('recipient'), t('line1'), t('line2'), t('city'), stateZip].filter(
    (s) => s !== '',
  );
  return parts.length === 0 ? '—' : parts.join(', ');
}

/** 支付信息 → 一行文案（取 `payment.channel` 与原币扣款额，缺则占位）。 */
export function paymentSummary(
  order: unknown,
  channelLabels: Readonly<Record<string, string>> = {},
): string {
  const p = (order as { payment?: unknown } | null)?.payment;
  const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
  const code = typeof o['channel'] === 'string' ? o['channel'] : '';
  // 全入口点击测试 2026-10-11：通道写中文名（原为 mock / stripe 代号）
  const channel = channelLabels[code] ?? code;
  const currency = typeof o['charge_currency'] === 'string' ? o['charge_currency'] : '';
  // ⚠️ `charge_amount` 是**最小单位**（USD=分）：直接拼就是 `USD 3350`（读大 100 倍，B43 / AJ-214）
  const amount = currency === '' ? '—' : minorMoneyText(o['charge_amount'], currency);
  const text = [channel, amount === '—' ? '' : amount].filter((s) => s !== '').join(' · ');
  return text === '' ? '—' : text;
}

/** 采购快照里"没有记录"时的占位文案。@see `purchaseLine` 的 @why ②③ */
export const PURCHASE_UNRECORDED = '未记录';

/**
 * 一条订单行项目的**采购信息** → 一行小字（日文原名 / JAN 码 / 采购来源）。
 *
 * @why 三列都取自**下单那一刻的快照**（迁移 021 / D-39），不是商品的当前值：
 *      采购员要买的是当时看到的那件。商品后来改了采购渠道，本行**不变**——
 *      所以这里显示什么，取决于订单，不取决于商品现在长什么样。
 *
 * @why 缺的字段显示「未记录」而不是**省略整段**：
 *      省略会让运营分不清"这个商品本来就没有 JAN 码"与"这单是在录入采购信息之前建的"——
 *      前者的下一步是"那就照名字找"，后者是"去问编辑补"，两个动作完全不同。
 *      「未记录」是可行动的：它明说"系统里没有"，而不是"这个值就是空的"。
 *
 * @why 三项**全缺**时给一句指向原因的话（而不是三个「未记录」摞在一起）：
 *      三列同时为空几乎只可能来自"这单建于迁移 021 之前"（迁移刻意不回填历史行）。
 *      写清原因，运营就不会以为系统漏了、也不会逐件去补商品——那补不上，
 *      因为历史订单的采购渠道本来就没被记录过。
 *
 * @why 采购来源**只在管理端显示**（这里是唯一消费方）：
 *      它是内部信息，泄露等于泄露成本结构与供应链；契约侧也因此把它收在
 *      `AdminOrderItem` 里，买家 `OrderItem` 没有这一列。
 *
 * @param item 契约 `AdminOrderItem`（字段缺失 = 没记录）
 */
export function purchaseLine(item: unknown): string {
  const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
  const pick = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  const ja = pick('title_ja');
  const jan = pick('jan_code');
  const src = pick('purchase_source');
  if (ja === null && jan === null && src === null) {
    return '未记录采购信息（这单建于采购信息录入之前，需人工补）';
  }
  const parts = [
    `日文原名：${ja ?? PURCHASE_UNRECORDED}`,
    `JAN：${jan ?? PURCHASE_UNRECORDED}`,
    `采购来源：${src ?? PURCHASE_UNRECORDED}`,
  ];
  return parts.join(' · ');
}

/**
 * 列表行里的**采购信息** → 每个行项目一行小字（复用 {@link purchaseLine}，与详情同口径）。
 *
 * @why 列表页也要显示采购信息（契约 0.6.26）：技术文档 §2.7 定义
 *      「待采购清单 = GET /admin/orders?status=paid」——筛完 `paid`，**这一页就是清单**。
 *      只在详情里显示的话，采购员要一张张点开（50 单点 50 次），清单在事实上不可用。
 *
 * @why 复用 {@link purchaseLine} 而不是给列表另写一个"短版"：
 *      两份文案的分歧是**静默的**——列表说「未记录」、详情说「这单建于采购信息录入之前」，
 *      运营在两个页面得到的信息不一致，而没有任何测试会红（两份各自都有用例）。
 *      列表窄就用 CSS 换行解决，不用第二套话术。
 *
 * @returns 每个行项目一行；没有 `items`（旧服务端 / 形状外）→ `[]`，由调用方显示"—"。
 */
/**
 * 列表行里每个商品的"中文名 × 件数"（与 {@link purchaseLines} 一一对应，同序）。
 * @why 两端逐页走查 2026-10-12：列表原先只有采购信息（日文原名 / JAN / 采购来源）——没有件数，采购员看不出要买几件；
 *      全部 / 已发货页签里运营也只能读日文猜卖了什么。
 * @limitation 名称缺失写「（商品名缺失）」：行项目的 title 是下单时快照，缺了说明数据异常，不留空让人以为没商品。
 */
export function itemNames(order: unknown): string[] {
  const o = (typeof order === 'object' && order !== null ? order : {}) as Record<string, unknown>;
  const items = o['items'];
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const it = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const title =
      typeof it['title'] === 'string' && it['title'].trim() !== ''
        ? it['title'].trim()
        : '（商品名缺失）';
    return `${title} × ${String(it['qty'] ?? '?')}`;
  });
}

export function purchaseLines(order: unknown): string[] {
  const o = (typeof order === 'object' && order !== null ? order : {}) as Record<string, unknown>;
  const items = o['items'];
  if (!Array.isArray(items)) return [];
  return items.map((it) => purchaseLine(it));
}

/** 发货表单（契约 `required: [carrier, tracking_no]`）。 */
export interface ShipForm {
  carrier: string;
  trackingNo: string;
}

export function emptyShipForm(): ShipForm {
  return { carrier: '', trackingNo: '' };
}

/**
 * 发货校验（与 `products` 同口径：一次返回全部错误，不留着让运营一条条试）。
 *
 * @why 长度也在这里判（AJ-315 / 第二轮审查 B24）：上限与服务端同一个常量
 *      （`SHIP_MAX_CHARS`），所以"前端放行、服务端拒"这个形态**结构上不可能出现**——
 *      只写一份就不会漂。此前两边都只判非空，超长的后果是服务端撞 PG 22001 折成
 *      泛化 40001，运营看到的提示指向错误的字段。
 * @why 提示里**带上上限数字**（与退款理由那条同口径）：运营得知道该删到多短，
 *      只知道"不能提交"会一直试。
 */
export function shipErrors(form: unknown): {
  ok: boolean;
  errors: Record<string, string>;
  first: string;
  /** 全部错误拼成一句（`；` 分隔），给 Toast / 摘要用。 */
  summary: string;
} {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const carrier = typeof f['carrier'] === 'string' ? f['carrier'].trim() : '';
  const trackingNo = typeof f['trackingNo'] === 'string' ? f['trackingNo'].trim() : '';
  const errors: Record<string, string> = {};
  if (carrier === '') errors['carrier'] = '承运商必填';
  else if (carrier.length > SHIP_MAX_CHARS.carrier) {
    errors['carrier'] = `承运商最多 ${String(SHIP_MAX_CHARS.carrier)} 字`;
  }
  if (trackingNo === '') errors['trackingNo'] = '运单号必填';
  else if (trackingNo.length > SHIP_MAX_CHARS.tracking_no) {
    errors['trackingNo'] = `运单号最多 ${String(SHIP_MAX_CHARS.tracking_no)} 字`;
  }
  const list = Object.values(errors);
  /**
   * @why 必须能一次拿到**全部**缺失项：只回 `first` 时（修订前 OrderDetail 就是这么用的），
   *      两个字段都空的表单会先报"承运商必填"，改完再点又报"运单号必填"——
   *      同一次想法要提交两遍才知道自己错在哪，而发货这类动作每点一次都要重走确认弹层。
   *      `first` 保留下来是为了"顶部摘要只要一句"的场景（见 @see）。
   */
  return {
    ok: list.length === 0,
    errors,
    first: list[0] ?? '',
    summary: list.join('；'),
  };
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
 * 退款校验：必填 + **不超过 500 字**（B7 / AJ-191）。
 *
 * @why reason 只要求非空、不设**最短**长度：退款原因是要进审计台账给人看的，
 *      "缺货""客户取消"四个字就够；设了最短长度只会逼人填满 `aaaa`。
 * @why 但**最长**必须有：理由会原样写进机构的 metadata，超了机构拒这一整笔退款；
 *      而重试必须沿用首次理由（KD-4 / AJ-175，同键同参）、`order_events` 又 append-only，
 *      于是"填太长"会把这张单**永久**钉在 refunding。
 *      服务端已在入口拒（`40001` / `refund_reason_too_long`），这里是**事前**拦截——
 *      只靠服务端的话，运营看到的是"填了 600 字、点了退款、报参数错误"，
 *      而错误文案里不会告诉他是因为太长。
 * @why 上限取自 shared 的 `REFUND_REASON_MAX_LENGTH` 而不是再写一个 500：
 *      两端各写一份的上限迟早漂成"前端放行、后端拒绝"（ADR-28：禁写死上限）。
 *
 * @limitation 与服务端同样按 **UTF-16 码元**计数（`.length`），含 emoji 的理由
 *      会比机构口径早一点被拦——保守方向，两端口径一致比"精确"更重要
 *      （不一致的表现是"前端能提交、后端拒"，正是这条要防的）。
 *
 * @see packages/shared/src/limits.ts（上限唯一真源）；OrderDetail.tsx（输入框 maxLength）
 */
export function refundErrors(form: unknown): { ok: boolean; first: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const reason = typeof f['reason'] === 'string' ? f['reason'].trim() : '';
  if (reason === '') return { ok: false, first: '退款原因必填（会记录下来）' };
  if (reason.length > REFUND_REASON_MAX_LENGTH) {
    return {
      ok: false,
      first: `退款原因不得超过 ${String(REFUND_REASON_MAX_LENGTH)} 字（当前 ${String(reason.length)} 字；超长会被机构拒，且订单会卡在退款中）`,
    };
  }
  return { ok: true, first: '' };
}

/** 表单 → 契约请求体。 */
export function toRefundBody(form: unknown): { reason: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  return { reason: typeof f['reason'] === 'string' ? f['reason'].trim() : '' };
}

/**
 * 退款请求**出错**之后要不要给"结果未知"的提醒（B41 残留 / AJ-230）。
 *
 * @param code `ApiError.code`（业务码；网络层失败为负数）
 * @returns 提醒文案；不需要提醒返回空串
 *
 * @why 退款是两段式：服务端先把订单提交为 `refunding`，再调机构。机构超时 / 报错时接口返回 5xx，
 *      网络断开时前端连响应都拿不到——这两种情况下**订单很可能已经是"退款中"**，
 *      而页面若只显示一句"服务器内部错误"，运营会当成"没退成"去机构后台手工退同一笔。
 * @why 4xx 业务性拒绝（40907 拒付中、40001 参数、40902 状态不允许…）不提醒：
 *      那是在落 `refunding` 之前就被拦下的，订单没动，提醒反而误导。
 * @limitation 前端分不出"5xx 发生在落 refunding 之前还是之后"，所以一律提醒并**同时刷新详情**——
 *              以刷新后的订单状态为准，文案也是这么说的。
 */
export function refundFailureNotice(
  code: unknown,
  retryAfterSec?: number,
  /** 服务端 40902 的 `data.reason`（AJ-456）：有它才能说清下一步 */
  reason?: unknown,
): string {
  const c = typeof code === 'number' ? code : 0;
  if (c === 40902 && reason === 'partial_refund_in_flight')
    return '有一笔部分退款还在处理中：先到「部分退款」点「同步」拿到结果，再整单退款。';
  if (c === 40902 && reason === 'fully_refunded_by_partials')
    return '部分退款已退满实收，这张单没有可退金额了（刷新后应显示「已退款」）。';
  // 50300 单独说（P2-49）：熔断在出发前就拒了，请求**没有发到机构**——说"结果未知"会把人吓去机构后台
  if (c === UPSTREAM_UNAVAILABLE_CODE) return upstreamUnavailableNotice(retryAfterSec);
  const unknownOutcome = c < 0 || c >= 50000;
  return unknownOutcome
    ? '⚠️ 这次退款的结果未知：请以上面刷新后的订单状态为准。若已是「退款中」，稍后再提交一次即可查询结果（不会重复退款）；不要去机构后台手工退款。'
    : '';
}

/** 50300 的统一文案（全额 / 部分退款共用）；秒数取自 `data.retry_after_ms`，没有就不编数字。 */
export function upstreamUnavailableNotice(retryAfterSec?: number): string {
  return retryAfterSec !== undefined
    ? `上游暂时不可用，请求未发出，约 ${Math.max(1, retryAfterSec)} 秒后可重试`
    : '上游暂时不可用，请求未发出，请稍后重试';
}

/**
 * 全额退款出错后、**重新取回订单之后**的提示（P2-49）：按刷新后的真实状态说话，而不是一律"结果未知"。
 *
 * @param a.order 刷新后的订单（取不到为 null → 回落到 `refundFailureNotice`）
 * @why 服务端两种失败都记 `refund_failed` 事件，靠 note 区分（orders-admin.ts `recordRefundFailed`）：
 *      `provider_failed:<ref>` = 机构**确认**失败（再提交会换新键重新发起）；
 *      `provider_error` = 机构超时 / 报错（结果未知，再提交只查询或同键重发）。
 *      两者对运营的下一步含义相反，不能混成一句。
 * @limitation 只看**最后一条**退款相关事件（refund_failed / refund_pending）；事件写入是 best-effort，
 *             缺事件时按"结果未知"说（保守：不让人以为可以放心重新发起）。
 */
export function fullRefundErrorNotice(a: {
  code: unknown;
  retryAfterSec?: number | undefined;
  reason?: unknown;
  order: unknown;
}): string {
  const base = refundFailureNotice(a.code, a.retryAfterSec, a.reason);
  if (a.code === 40902 && base !== '') return base;
  if (base === '' || a.code === UPSTREAM_UNAVAILABLE_CODE || a.order === null) return base;
  const status = readStatus(a.order);
  if (status === 'refunded') return '刷新后订单已是「已退款」：这笔退款实际已完成，无需再操作。';
  if (status !== 'refunding') return base;
  const events = (a.order as { events?: unknown }).events;
  const last = (Array.isArray(events) ? events : [])
    .filter(
      (e: { status?: unknown }) => e?.status === 'refund_failed' || e?.status === 'refund_pending',
    )
    .at(-1) as { status?: unknown; note?: unknown } | undefined;
  if (
    last?.status === 'refund_failed' &&
    typeof last.note === 'string' &&
    last.note.startsWith('provider_failed')
  ) {
    return '机构确认失败（钱没有退出去）：订单停在「退款中」，可再提交一次重新发起。';
  }
  return '结果未知：请点「全额退款…」→「重新提交退款」取回结果（只会查询或同键重发，不会退两次），不要去 Stripe 后台重复退。';
}

/**
 * 这张单当前是不是**被拒付限制锁着**——决定「人工解除拒付限制」入口出不出来
 * （B1b / AJ-194 的前端落地，AJ-291）。
 *
 * @why 抽成布尔函数而不在 JSX 里写 `order.has_dispute === true`：
 *      这是**不可逆动作**（契约没有"重新上锁"的接口）的唯一入口开关，
 *      判据要有一处能被单测钉住的边界表，而不是散在模板里的一个比较。
 *      ⚠️ 刻意**不返回 Gate**：详情页只有在它为真时才渲染那一块，
 *      返回 `{ok:false, reason}` 的话 reason 永远显示不出来——
 *      那是一段走不到、也因此永远拿不到红灯证据的分支（约束八）。
 *
 * @why **不看订单状态**：拒付可能开在 `paid`，也可能开在已退款之后协商和好；
 *      限制加在订单层、与状态机无关。按状态分叉只会造出一张没人维护的组合表。
 * @limitation `has_dispute` **缺失即不放行**（与 `refundGate` 的"缺失即放行"相反）：
 *      解除不可逆，且它的全部意义就是"把锁打开"——
 *      在不知道有没有锁的时候给一个"可能有用"的按钮，等于把不可逆动作变成试错。
 *      拦错的代价是"按钮不出现"，放行错的代价是"白解一次且留痕"。
 *
 * @see OrderDetail.tsx（唯一消费方）
 */
export function isDisputeLocked(order: unknown): boolean {
  return (order as { has_dispute?: unknown } | null)?.has_dispute === true;
}

/**
 * 拒付限制是哪一种：进行中 / 已败诉 / 看不出（列表行没有时间线）。
 * @why 规律排查 2026-10-12：`has_dispute` 的含义是"有未解除的拒付限制（进行中，或已败诉）"（服务端 mark-disputed.ts，
 *      契约 0.6.10），后台原先一律写"拒付中 / 有进行中的拒付"——已败诉的单运营去风控页"处理"，发现早已结案。
 * @why 按时间线里**最后一条**开案 / 结案事件判：败诉后又开新案的，以新案为准。
 * @limitation 只认结案备注 `<id>:lost`（服务端写法）；时间线缺失时返回 'locked'，文案写两种情况都对的说法。
 */
export function disputeLockState(order: unknown): 'open' | 'lost' | 'locked' | null {
  if (!isDisputeLocked(order)) return null;
  // 服务端判定优先（契约 0.6.89 `payment_dispute`，与买家端同一判据；列表行也带）；时间线只作旧服务端的兜底
  const pd = (order as { payment_dispute?: unknown }).payment_dispute;
  if (pd === 'open' || pd === 'lost') return pd;
  const events = (order as { events?: unknown }).events;
  if (!Array.isArray(events)) return 'locked';
  const last = [...events]
    .reverse()
    .find(
      (e: { status?: unknown }) => e?.status === 'dispute_opened' || e?.status === 'dispute_closed',
    ) as { status?: unknown; note?: unknown } | undefined;
  if (last === undefined) return 'locked';
  if (last.status === 'dispute_opened') return 'open';
  return typeof last.note === 'string' && last.note.endsWith(':lost') ? 'lost' : 'locked';
}

/** 拒付限制的徽章字与右栏「风险状态」一句话（与 {@link disputeLockState} 同口径）。 */
export const DISPUTE_LOCK_TEXT: Record<
  'open' | 'lost' | 'locked',
  { badge: string; detail: string }
> = {
  open: {
    badge: '拒付中',
    detail:
      '有进行中的拒付：退款与发货已锁，等银行结案（只有拒付其实已结束、系统没收到结案时，才用「解除拒付限制…」）',
  },
  lost: {
    badge: '拒付已败诉',
    detail: '拒付已败诉（货款已被银行退回买家）：不要再发货，也无需退款',
  },
  locked: {
    badge: '拒付锁定',
    detail: '有未解除的拒付限制：退款与发货已锁（可在「解除拒付限制…」人工解除）',
  },
};

/**
 * 拒付限制下的退款提示（按进行中 / 已败诉 / 看不出分开说）。
 * @why 三天提交复查 2026-10-12：99a204b 曾写"确需解除请点本单的「解除拒付限制…」"——解锁后再退款，支付机构对争议中 /
 *      已被拉回的付款一律拒（mark-disputed.ts 的 @measured：charge_disputed / refund_disputed_payment），订单卡在「退款中」。
 *      所以这里**不指向解锁**：进行中的等银行结案；已败诉的钱已经回到买家手里，不需要再退。
 * @limitation 解锁只适用于"拒付其实已结束、系统没收到结案"（见解除表单说明）；那种情况运营要先核实，不在这句提示里引导。
 */
export function disputeRefundBlockedText(order: unknown): string {
  const d = disputeLockState(order);
  if (d === 'lost') return '拒付已败诉：货款已被银行退回买家，不能也无需再退款';
  if (d === 'open')
    return '银行正在处理这笔付款的拒付，现在不能退款（支付机构不接受对争议中的付款退款），请等银行结案';
  return '这单有拒付限制，现在不能退款（争议中或已被银行拉回的付款无法退款），请等银行结案';
}

/** 解除拒付限制的表单（契约 `required: [reason]`）。 */
export interface ReleaseForm {
  reason: string;
}

export function emptyReleaseForm(): ReleaseForm {
  return { reason: '' };
}

/**
 * 解除理由校验：必填 + 不超过 `ADMIN_NOTE_MAX_LENGTH`。
 *
 * @why 理由**必须**填：这个口能把一张"钱可能已被机构拉回"的订单解锁成可发货、可退款，
 *      是管理端权限最大的动作之一。没有理由的解锁在审计里就是一条说不清的记录，
 *      而"当时为什么解开"这个问题一定发生在**出事之后**——那时没有理由就没有答案。
 * @why 上限取自 shared 而不是再写一个 500：两端各写一份迟早漂成"前端放行、后端拒绝"
 *      （与 `refundErrors` 同一条，ADR-28：禁写死上限）。
 * @limitation 不校验"理由是否充分"（机器判断不了），也不设最短长度——
 *      逼人填满 `aaaa` 比留一句短话更糟。
 *
 * @see packages/shared/src/limits.ts（`ADMIN_NOTE_MAX_LENGTH` 唯一真源）
 */
export function releaseErrors(form: unknown): { ok: boolean; first: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  const reason = typeof f['reason'] === 'string' ? f['reason'].trim() : '';
  if (reason === '') return { ok: false, first: '解除理由必填（会记录在订单时间线里）' };
  if (reason.length > ADMIN_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      first: `解除理由不得超过 ${String(ADMIN_NOTE_MAX_LENGTH)} 字（当前 ${String(reason.length)} 字）`,
    };
  }
  return { ok: true, first: '' };
}

/** 表单 → 契约请求体。 */
export function toReleaseBody(form: unknown): { reason: string } {
  const f = (typeof form === 'object' && form !== null ? form : {}) as Record<string, unknown>;
  return { reason: typeof f['reason'] === 'string' ? f['reason'].trim() : '' };
}

/**
 * 解除**成功之后**要摆在页面上的那句话（AJ-291）。
 *
 * @why 解除的是"限制"不是"事实"：`payments.dispute_*` **一个字都没动**，
 *      这条拒付照样留在风控列表里、照样能被 Stripe 判定为败诉并把钱拉走。
 *      不说这句，运营会理解成"拒付处理完了"，然后放心发货——
 *      而那正是"钱货两空"的标准路径（发货闸门解除后立刻可点）。
 * @why 与 `notice` 而不是 `ok` 同层：它是**提示**不是成功确认，
 *      但必须和"已解除"同时出现，不能只闪一条 toast。
 */
export const RELEASE_DONE_NOTICE =
  '⚠️ 已解除本单的拒付限制：现在可以发货 / 退款了。' +
  '但拒付**本身没有结案**——风控列表里仍然看得到它，机构仍可能判定败诉并把钱收回。' +
  '是否发货请按业务判断，不要因为按钮亮了就发。';

/** 金额拆分（A-9 / AJ-467）：只列订单上真有的字段；买家实付按支付币种（最小单位 → 人话）。 */
export function amountBreakdown(order: unknown): Array<{ label: string; value: string }> {
  const o = (order ?? {}) as Record<string, unknown>;
  const out: Array<{ label: string; value: string }> = [];
  if (Number.isInteger(o['items_jpy']))
    out.push({ label: '商品合计', value: moneyText(o['items_jpy']) });
  // 关税紧跟商品合计、写"其中"（与小程序 MP-11 同口径）：它含在商品价里，与运费并列会被读成另收的第三笔
  //   ——第二轮审计浏览器验收时看到 864 + 4,950 + 130 ≠ 实付 5,814
  if (Number.isInteger(o['duty_jpy']))
    out.push({ label: '其中预估关税（含在商品价内）', value: moneyText(o['duty_jpy']) });
  if (Number.isInteger(o['shipping_jpy']))
    out.push({ label: '运费', value: moneyText(o['shipping_jpy']) });
  // 买家实付只认**已扣款**的支付行（规律排查 2026-10-12）：`payment` 是最新一条未取消的行、不论状态，
  //   待付款 / 超时关闭的单原先也显示"买家实付 $80.00"，而订单总表同一单的实付是空的（只认 succeeded / refunded）。
  //   详情带 `payments[]` 时按它判；列表快照没有这一项时退回 `payment`（列表不显示金额区，只是兜底）
  const pays = Array.isArray(o['payments'])
    ? (o['payments'] as Array<Record<string, unknown>>)
    : null;
  const charged =
    pays === null
      ? ((typeof o['payment'] === 'object' && o['payment'] !== null ? o['payment'] : {}) as Record<
          string,
          unknown
        >)
      : ([...pays]
          .reverse()
          .find((x) => x['status'] === 'succeeded' || x['status'] === 'refunded') ?? null);
  if (
    charged !== null &&
    typeof charged['charge_currency'] === 'string' &&
    Number.isInteger(charged['charge_amount'])
  ) {
    out.push({
      label: '买家实付',
      value: minorMoneyText(charged['charge_amount'], charged['charge_currency']),
    });
  } else if (pays !== null && pays.length > 0) {
    // 迟到付款（三天提交复查 2026-10-12）：钱确实到账了，但支付行停在 cancelled（关单时取消、落账回滚，只记 late_paid 事件）——
    //   不能写"尚未扣款"，那与"迟到付款待退"自相矛盾；取最后一条支付行的金额，并说要退回
    const last = pays[pays.length - 1] ?? {};
    if (
      o['late_paid'] === true &&
      typeof last['charge_currency'] === 'string' &&
      Number.isInteger(last['charge_amount'])
    ) {
      out.push({
        label: '买家实付（关单后才到账，需全额退回）',
        value: minorMoneyText(last['charge_amount'], last['charge_currency']),
      });
    } else out.push({ label: '买家实付', value: '尚未扣款' });
  }
  // 部分退款汇总（两端逐页走查第三轮 2026-10-12）：原先只在「部分退款…」抽屉与时间线里，金额区看不出退了多少、还有多少在途
  const refunds = Array.isArray(o['partial_refunds'])
    ? (o['partial_refunds'] as Array<Record<string, unknown>>)
    : [];
  const sumOf = (pick: (s: unknown) => boolean): { minor: number; currency: string } => {
    let minor = 0;
    let currency = '';
    for (const r of refunds) {
      if (!pick(r['status']) || !Number.isInteger(r['amount_minor'])) continue;
      minor += r['amount_minor'] as number;
      if (typeof r['currency'] === 'string') currency = r['currency'];
    }
    return { minor, currency };
  };
  const done = sumOf((s) => s === 'succeeded');
  const inFlight = sumOf((s) => s === 'initiated' || s === 'pending' || s === 'unknown');
  if (done.minor > 0)
    out.push({ label: '已部分退款', value: minorMoneyText(done.minor, done.currency) });
  if (inFlight.minor > 0)
    out.push({ label: '部分退款处理中', value: minorMoneyText(inFlight.minor, inFlight.currency) });
  return out;
}

/** 物流块（A-9 / AJ-467）：没发货（没有运单号）→ null，整块不渲染。 */
export function logisticsView(order: unknown): { text: string; url: string } | null {
  const o = (order ?? {}) as Record<string, unknown>;
  const tracking = typeof o['tracking_no'] === 'string' ? o['tracking_no'] : '';
  if (tracking === '') return null;
  const carrier = typeof o['carrier'] === 'string' ? o['carrier'] : '';
  const shippedAt = typeof o['shipped_at'] === 'string' ? formatJst(o['shipped_at']) : '';
  return {
    text: [carrier, tracking, shippedAt === '' ? '' : `发货于 ${shippedAt}（日本时间）`]
      .filter((x) => x !== '')
      .join(' · '),
    url: typeof o['tracking_url'] === 'string' ? o['tracking_url'] : '',
  };
}

/** 改址历史行（A-4 / AJ-467，契约 0.6.67 `address_history`）：改前地址摘要 + 谁 + 何时。 */
export function addressHistoryRows(
  order: unknown,
): Array<{ id: string; text: string; actor: string; atText: string }> {
  const list = (order as { address_history?: unknown } | null)?.address_history;
  if (!Array.isArray(list)) return [];
  return list
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    .map((h) => ({
      id: String(h['id'] ?? ''),
      text: addressSummary({ address: h['snapshot'] }),
      actor: typeof h['actor'] === 'string' ? h['actor'] : '',
      atText: typeof h['at'] === 'string' ? formatJst(h['at']) : '',
    }));
}

/**
 * 第一次全额退款的原因（时间线里最早一条"开始退款"的备注；两端逐页走查第三轮 2026-10-12）。
 * @why 退款中的单重试时，服务端沿用第一次的原因（机构幂等键按订单固定，换原因 = 同键异参会被机构拒）；
 *      表单原先还要运营再选一次原因——选了也不生效。拿它在表单里写明"沿用"，提交也带它。
 * @returns 没有这条事件或备注为空 → null（调用方退回让运营填写）
 */
export function firstRefundReason(order: unknown): string | null {
  const events = (order as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    const ev = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    if (ev['status'] !== 'refunding') continue;
    const note = typeof ev['note'] === 'string' ? ev['note'].trim() : '';
    return note === '' ? null : note;
  }
  return null;
}
