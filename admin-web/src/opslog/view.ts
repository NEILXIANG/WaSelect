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

export function auditRows(items: readonly unknown[]): AuditRowView[] {
  return items
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => {
      const status = typeof i['status_code'] === 'number' ? i['status_code'] : null;
      return {
        id: Number(i['id']),
        timeText: formatJst(i['created_at']),
        // 有邮箱显示邮箱（运营认得同事邮箱，不认得内部 id）
        actor:
          typeof i['actor_email'] === 'string' && i['actor_email'] !== ''
            ? i['actor_email']
            : String(i['actor'] ?? ''),
        action: ACTION_LABELS[String(i['action'] ?? '')] ?? String(i['action'] ?? ''),
        actionRaw: String(i['action'] ?? ''),
        targetText:
          typeof i['target'] === 'string' && i['target'] !== '' ? shortRef(i['target']) : '—',
        targetTitle: typeof i['target'] === 'string' ? i['target'] : '',
        targetHref: ((): string => {
          const target = typeof i['target'] === 'string' ? i['target'] : '';
          const page = targetPage(String(i['action'] ?? ''));
          return page === null || target === '' ? '' : `#/${page}/${encodeURIComponent(target)}`;
        })(),
        statusText: status === null ? '—' : String(status),
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

export interface ReconciliationView {
  headline: string;
  ok: boolean;
  lines: { text: string; samples: ReconcileSample[] }[];
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

export function reconciliationView(run: ReconciliationRun | null): ReconciliationView {
  if (run === null) return { headline: '还没有自动核对记录', ok: false, lines: [] };
  const when = formatJst(run.ran_at);
  const bad = Object.entries(run.counts).filter(([, n]) => n > 0);
  if (bad.length === 0)
    return { headline: `最近一次自动核对 ${when}：无异常`, ok: true, lines: [] };
  return {
    headline: `最近一次自动核对 ${when}：发现 ${String(bad.length)} 类异常，需要人工处理`,
    ok: false,
    lines: bad.map(([k, n]) => ({
      text: `${RECONCILE_CLASS_LABELS[k] ?? k}：${String(n)}`,
      samples: (run.samples[k] ?? []).map(toSample),
    })),
  };
}
