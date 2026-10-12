/**
 * 职责：运营日志页的纯函数（剩余清单 3-2）——审计行、最近一次对账的展示模型。
 *
 * @why 与其它页同构：逻辑在 view.ts（可单测），组件只渲染。
 * @limitation 对账类名的中文映射是**文案层**：服务端新增一类而这里没跟上时原样显示英文 key（看得见，不吞信息）。
 * @see ../../../server/src/app/daily-reconciliation.ts（类名真源）；contracts/api-contract.yaml 0.6.32
 */
import { formatJst, shortRef } from '../format.js';

export const RECONCILE_CLASS_LABELS: Readonly<Record<string, string>> = {
  dangling_initiated_payments: '发起支付后长时间无结果',
  paid_without_succeeded_payment: '订单已付但无成功支付行',
  callback_anomalies_48h: '近 48 小时回调异常（迟到付款 / 金额不符等）',
  unfinished_callbacks: '回调登记后未处理完',
  stalled_heartbeats: '定时任务心跳停滞',
  stuck_refunds: '退款滞留超过 24 小时',
  stuck_partial_refunds: '部分退款滞留超过 24 小时',
  provider_refund_unrecorded: '机构侧已退款、本地无退款记录（勿再发货）',
  fx_rate_aging: '汇率快过期（请尽快在运营配置里录入）',
  // AJ-425：两类"有人负责却没人看得到"的单，进对账后也要说人话
  late_paid_unrefunded: '迟到付款（钱已扣、订单已关）尚未退款',
  after_sales_waiting: '售后申请等待超过 24 小时',
  order_mail_unsent: '买家通知邮件已放弃（出了 48 小时补发窗口仍未发出）',
  // AJ-425 回扫：审核模式三类此前漏配，运营日志页一直原样显示英文
  review_mode_no_deadline: '审核模式已开启但没设到期日',
  review_mode_expired: '审核模式已过到期日仍在开启',
  review_mode_closing: '审核模式临近到期',
  // 空库上线演练 2026-10-12：买家此刻能不能下单的三项前提
  launch_not_ready: '上线配置缺项（买家可能下不了单）',
};

/**
 * 审计 action（`METHOD 路径模板` / `CLI …`）→ 中文操作名（三端联动 UI 模拟 2026-10-08：原先直接显示
 * `POST /admin/users/:id/unblock`，运营读不懂）。认不出的原样显示（看得见，不静默丢）。
 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'POST /admin/products': '新建商品',
  'PUT /admin/products/:id': '编辑商品',
  'PATCH /admin/products/:id/status': '商品上下架',
  'PATCH /admin/products/:id/stock': '改库存',
  'POST /admin/upload': '上传图片',
  // AJ-491：商品分类改为后台可配置
  'POST /admin/categories': '新建分类',
  'PUT /admin/categories/:key': '编辑分类',
  'DELETE /admin/categories/:key': '删除分类',
  'POST /admin/banners': '新建 Banner',
  'PUT /admin/banners/:id': '编辑 Banner',
  'DELETE /admin/banners/:id': '删除 Banner',
  'POST /admin/orders/:id/ship': '发货',
  'PATCH /admin/orders/:id/shipment': '改运单号',
  'POST /admin/orders/:id/address': '发货前改址',
  'POST /admin/orders/:id/cancel': '取消未付订单',
  'POST /admin/orders/:id/refund': '全额退款',
  'POST /admin/refund': '退款',
  'POST /admin/orders/:id/partial-refunds': '部分退款',
  'POST /admin/orders/:id/partial-refunds/:refundId/sync': '同步部分退款',
  'POST /admin/orders/:id/dispute/release': '解除拒付限制',
  'POST /admin/orders/:id/after-sales/:rid/resolve': '处理售后',
  'POST /admin/users/:id/block': '拉黑用户',
  'POST /admin/users/:id/unblock': '解除拉黑',
  'PUT /admin/ops/sales-pause': '停售 / 恢复接单',
  'PUT /admin/shipping-rates': '替换运费表',
  'POST /admin/fx': '维护汇率',
  'GET /admin/exports/:kind': '导出表格',
  'CLI admin.create': '命令行建管理员',
  'CLI admin.password.reset': '命令行改密',
  'CLI admin.totp.enable': '开通手机验证',
  'CLI admin.totp.disable': '关闭手机验证',
  // 严格检查 A-5 / ADM-8（AJ-470）：此前显示英文原文的三类 + 之后新增的端点
  'POST /admin/orders/:id/notes': '添加备注',
  'POST /admin/orders/ship-batch': '批量发货',
  'DELETE /admin/customers/:id/events': '删除客户行为记录',
  'POST /admin/orders/:id/shipment/revert': '撤销发货',
  'CLI admin.revoke': '命令行撤销管理员',
};

export interface AuditRowView {
  id: number;
  timeText: string;
  actor: string;
  /** 中文操作名；认不出时等于 `actionRaw`。 */
  action: string;
  /** 原始 action（小字附在旁边，查日志 / 对代码用）。 */
  actionRaw: string;
  targetText: string;
  /** 对象全文（悬停看；正文是 shortRef 缩短过的）。 */
  targetTitle: string;
  /** 对象能点去哪（走查 2026-10-08）：订单 / 客户详情的 hash；其它（商品编辑不进网址、Banner 无详情）为空串。 */
  targetHref: string;
  statusText: string;
  /** 原始状态码（悬停看，查日志用）；没有时为空串。 */
  statusTitle: string;
  /** 状态码 ≥ 400：这次操作没成功（例如退款调机构失败），行标红。 */
  failed: boolean;
}

/**
 * action 路由 → 对象详情的页面（走查 2026-10-08：对象列只有内部 id，运营认不出是哪张单）。
 * @limitation 只给订单与客户：商品编辑态不进网址（App.tsx @limitation），Banner 没有详情页。
 */
function targetPage(action: string): 'orders' | 'customers' | null {
  if (action.includes('/admin/orders/:id')) return 'orders';
  if (action.includes('/admin/customers/:id') || action.includes('/admin/users/:id')) {
    return 'customers';
  }
  return null;
}

/**
 * 结果列（全入口点击测试 2026-10-12：原写 200 / 201 / 202，运营看不懂）。
 * @why 202 单列：退款类是"已提交给支付机构"，这一行记的是提交那一刻；最终结果（成功 / 失败）在订单详情里。
 *      说"成功"会让人以为钱已经退了，说"处理中"又会让已经退完的单看着像还没好。
 */
function resultText(status: number | null): string {
  if (status === null) return '—';
  if (status === 202) return '已提交（结果见订单详情）';
  if (status >= 200 && status < 300) return '成功';
  if (status >= 400 && status < 500) return '被拒绝';
  if (status >= 500) return '出错';
  return String(status);
}

const EXPORT_KIND_LABELS: Readonly<Record<string, string>> = {
  orders: '订单总表',
  purchase: '待采购清单',
  customs: '报关表',
};

/**
 * 对象列（全入口点击测试 2026-10-12：原写 purchase、health、img/…、batch:1/1）。
 * 订单 / 商品优先用服务端回带的 `target_label`（订单号 / 商品名，AJ-499）；这里只管服务端认不出的那些。
 * @limitation 客户仍是缩短的内部编号（可点进客户详情）。
 */
function targetLabel(
  action: string,
  target: string,
  categoryNames: Readonly<Record<string, string>>,
): string {
  if (action === 'GET /admin/exports/:kind') return EXPORT_KIND_LABELS[target] ?? target;
  if (action.startsWith('POST /admin/categories') || action.includes('/admin/categories/:key'))
    return categoryNames[target] ?? target;
  if (action === 'POST /admin/upload') return '图片';
  const batch = /^batch:(\d+)\/(\d+)$/.exec(target);
  if (action === 'POST /admin/orders/ship-batch' && batch !== null)
    return `成功 ${batch[1] ?? ''} / 共 ${batch[2] ?? ''} 单`;
  return shortRef(target);
}

export function auditRows(
  items: readonly unknown[],
  opts: { categoryNames?: Readonly<Record<string, string>> } = {},
): AuditRowView[] {
  const categoryNames = opts.categoryNames ?? {};
  return items
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => {
      const status = typeof i['status_code'] === 'number' ? i['status_code'] : null;
      return {
        id: Number(i['id']),
        timeText: formatJst(i['created_at']),
        // 有邮箱显示邮箱（运营认得同事邮箱，不认得内部 id）
        // 命令行写"命令行（服务器上执行）"，不写 cli:admin-password（全入口点击测试 2026-10-12）
        actor:
          typeof i['actor_email'] === 'string' && i['actor_email'] !== ''
            ? i['actor_email']
            : String(i['actor'] ?? '').startsWith('cli:')
              ? '命令行（服务器上执行）'
              : String(i['actor'] ?? ''),
        action: ACTION_LABELS[String(i['action'] ?? '')] ?? String(i['action'] ?? ''),
        actionRaw: String(i['action'] ?? ''),
        // AJ-499：服务端给了订单号 / 商品名就用它；否则按动作猜（导出表名、分类名、图片…），再不行缩短 id
        targetText:
          typeof i['target_label'] === 'string' && i['target_label'] !== ''
            ? i['target_label']
            : typeof i['target'] === 'string' && i['target'] !== ''
              ? targetLabel(String(i['action'] ?? ''), i['target'], categoryNames)
              : '—',
        targetTitle: typeof i['target'] === 'string' ? i['target'] : '',
        targetHref: ((): string => {
          const target = typeof i['target'] === 'string' ? i['target'] : '';
          const page = targetPage(String(i['action'] ?? ''));
          return page === null || target === '' ? '' : `#/${page}/${encodeURIComponent(target)}`;
        })(),
        statusText: resultText(status),
        statusTitle: status === null ? '' : `HTTP ${String(status)}`,
        failed: status !== null && status >= 400,
      };
    });
}

export interface ReconciliationRun {
  ran_at: string;
  counts: Record<string, number>;
  samples: Record<string, string[]>;
}

/** 一条取样：认得出订单 id 时链到订单详情（`href` 非空），否则原样显示。 */
export interface ReconcileSample {
  label: string;
  href: string;
}

/** 一条取样：认得出订单 id 时链到订单详情（`href` 非空），否则原样显示。 */
export interface ReconcileSample {
  label: string;
  href: string;
}

// 不用前导 \b：迟到付款的取样是 `evt_late_ord-<uuid>`，`_ord` 之间不是词边界
const ORDER_ID = /ord-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/**
 * 取样 id → 可点的链接。
 * @why 三端模拟测试 2026-10-11：取样原样拼成一长串 36 位 id，运营认不出、也打不开是哪张单。
 *      服务端取样有两种形状：`ord-<uuid>`（订单类异常）与 `order.paid:ord-<uuid>`（通知键），都从中认出订单 id。
 * @limitation 取样里只有 id、没有单号，所以显示缩短的 id 而不是单号；要显示单号得让服务端取样带上它。
 */
function toSample(raw: string): ReconcileSample {
  const id = ORDER_ID.exec(raw)?.[0];
  return id === undefined
    ? { label: shortRef(raw), href: '' }
    : { label: `${id.slice(0, 12)}…`, href: `#/orders/${encodeURIComponent(id)}` };
}

/** 谁来处理：运营（有入口能直接做）/ 技术人员 / 留意即可（多为正常现象，持续增多再查）。 */
export type ReconcileOwner = 'ops' | 'tech' | 'watch';

export interface ReconcileRow {
  key: string;
  label: string;
  count: number;
  owner: ReconcileOwner;
  /** 怎么处理（一句人话）。 */
  advice: string;
  /** 「去处理」的入口（订单筛选 / 配置页）；空串 = 没有可直接操作的页面。 */
  href: string;
  /** 示例最多 3 个（排查用）；`more` = 其余条数。 */
  samples: ReconcileSample[];
  more: number;
}

export interface ReconciliationView {
  headline: string;
  ok: boolean;
  /** 「2 类需要运营处理，1 类请转技术人员」；无异常时为空串。 */
  summary: string;
  rows: ReconcileRow[];
}

/**
 * 每类异常：谁处理、怎么处理、去哪处理；`money` = 涉及钱，排最前。
 * @why 三端模拟测试 2026-10-11（用户截图）：原先每类后面铺一墙 ord-… 链接，运营看不出先做什么、谁来做。
 *      成熟电商后台的做法是"异常看板"：一类一行、给处理建议与入口，明细进列表页看。
 * @limitation 入口只能指到已有的筛选（attention / status / 配置页）；没有对应筛选的类（邮件、心跳等）只给建议与示例。
 */
const GUIDE: Readonly<
  Record<string, { owner: ReconcileOwner; advice: string; href?: string; money?: boolean }>
> = {
  late_paid_unrefunded: {
    owner: 'ops',
    money: true,
    advice: '买家的钱已经扣了、订单却已关闭：逐单全额退款',
    href: '#/orders?attention=late_paid',
  },
  stuck_refunds: {
    owner: 'ops',
    money: true,
    advice: '退款发出超过 24 小时还没结果：到订单详情点「同步」看支付机构的结果',
    href: '#/orders?status=refunding',
  },
  stuck_partial_refunds: {
    owner: 'ops',
    money: true,
    advice: '部分退款超过 24 小时还没结果：到订单详情的部分退款里点「同步」',
    href: '#/orders?attention=partial_refund',
  },
  callback_anomalies_48h: {
    owner: 'ops',
    money: true,
    advice: '支付结果与订单对不上（多为关单后才付款）：逐单核对，该退的退',
    href: '#/orders?attention=late_paid',
  },
  provider_refund_unrecorded: {
    owner: 'tech',
    money: true,
    advice: '支付机构那边已退款、本地没有记录：这些单先不要发货，请技术人员补记',
  },
  paid_without_succeeded_payment: {
    owner: 'tech',
    money: true,
    advice: '订单显示已付款，却查不到成功的支付记录：先不要发货，请技术人员核对',
  },
  after_sales_waiting: {
    owner: 'ops',
    advice: '买家已经等了超过 24 小时：在订单详情里回复处理结果',
    href: '#/orders?attention=after_sale',
  },
  fx_rate_aging: { owner: 'ops', advice: '展示汇率快过期：去运营配置录入新汇率', href: '#/ops' },
  order_mail_unsent: {
    owner: 'tech',
    advice:
      '付款 / 发货通知邮件没发出去，买家没收到：请技术人员检查邮件配置；着急的单可在订单详情里找到联系邮箱手工联系',
  },
  unfinished_callbacks: { owner: 'tech', advice: '支付机构的通知登记后没处理完：请技术人员检查' },
  stalled_heartbeats: {
    owner: 'tech',
    advice: '定时任务可能停了，过期关单、自动签收都不会执行：请技术人员检查',
  },
  launch_not_ready: {
    owner: 'ops',
    advice:
      '按示例逐条补：运费表与汇率在「运营配置」录入；审核商品在「商品管理」上架、补库存——审核商品编号填错请技术人员改配置后重启',
    href: '#/ops',
  },
  review_mode_no_deadline: {
    owner: 'tech',
    advice: '审核模式开着却没设到期日：请技术人员补上',
    href: '#/settings',
  },
  review_mode_expired: {
    owner: 'tech',
    advice: '审核模式已过到期日仍开着：请技术人员关闭',
    href: '#/settings',
  },
  review_mode_closing: {
    owner: 'tech',
    advice: '审核模式快到期：确认审核是否已通过',
    href: '#/settings',
  },
  dangling_initiated_payments: {
    owner: 'watch',
    advice: '多为买家打开付款页后放弃，订单到期会自动关闭；持续增多时请技术人员看看支付通道',
  },
};

const OWNER_RANK: Readonly<Record<ReconcileOwner, number>> = { ops: 0, tech: 1, watch: 2 };

export function reconciliationView(run: ReconciliationRun | null): ReconciliationView {
  if (run === null) return { headline: '还没有自动核对记录', ok: false, summary: '', rows: [] };
  const when = formatJst(run.ran_at);
  const bad = Object.entries(run.counts).filter(([, n]) => n > 0);
  if (bad.length === 0)
    return { headline: `最近一次自动核对 ${when}：无异常`, ok: true, summary: '', rows: [] };
  const rows = bad
    .map(([k, n]): ReconcileRow & { money: boolean } => {
      const g = GUIDE[k] ?? { owner: 'tech' as const, advice: '请技术人员查看' };
      const all = (run.samples[k] ?? []).map(toSample);
      return {
        key: k,
        label: RECONCILE_CLASS_LABELS[k] ?? k,
        count: n,
        owner: g.owner,
        advice: g.advice,
        href: g.href ?? '',
        samples: all.slice(0, 3),
        more: Math.max(0, n - Math.min(3, all.length)),
        money: g.money === true,
      };
    })
    .sort((a, b) => Number(b.money) - Number(a.money) || OWNER_RANK[a.owner] - OWNER_RANK[b.owner])
    .map(({ money: _money, ...r }) => r);
  const ops = rows.filter((r) => r.owner === 'ops').length;
  const tech = rows.filter((r) => r.owner === 'tech').length;
  const summary = [
    ops > 0 ? `${String(ops)} 类需要运营处理` : '',
    tech > 0 ? `${String(tech)} 类请转技术人员` : '',
  ]
    .filter((x) => x !== '')
    .join('，');
  return {
    headline: `最近一次自动核对 ${when}：发现 ${String(bad.length)} 类异常`,
    ok: false,
    summary,
    rows,
  };
}
