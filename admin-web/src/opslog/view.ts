/**
 * 职责：运营日志页的纯函数（剩余清单 3-2）——审计行、最近一次对账的展示模型。
 *
 * @why 与其它页同构：逻辑在 view.ts（可单测），组件只渲染。
 * @limitation 对账类名的中文映射是**文案层**：服务端新增一类而这里没跟上时原样显示英文 key（看得见，不吞信息）。
 * @see ../../../server/src/app/daily-reconciliation.ts（类名真源）；contracts/api-contract.yaml 0.6.32
 */
import { formatJst } from '../format.js';

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
  'POST /admin/users/:id/block': '拉黑用户',
  'POST /admin/users/:id/unblock': '解除拉黑',
  'PUT /admin/ops/sales-pause': '停售 / 恢复接单',
  'PUT /admin/shipping-rates': '替换运费表',
  'POST /admin/fx': '维护汇率',
  'GET /admin/exports/:kind': '导出 CSV',
  'CLI admin.create': '命令行建管理员',
  'CLI admin.password.reset': '命令行改密',
  'CLI admin.totp.enable': '开通二次验证',
  'CLI admin.totp.disable': '关闭二次验证',
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
  statusText: string;
  /** 状态码 ≥ 400：这次操作没成功（例如退款调机构失败），行标红。 */
  failed: boolean;
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
        targetText: typeof i['target'] === 'string' && i['target'] !== '' ? i['target'] : '—',
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

export interface ReconciliationView {
  headline: string;
  ok: boolean;
  lines: string[];
}

export function reconciliationView(run: ReconciliationRun | null): ReconciliationView {
  if (run === null) return { headline: '还没有对账记录', ok: false, lines: [] };
  const when = formatJst(run.ran_at);
  const bad = Object.entries(run.counts).filter(([, n]) => n > 0);
  if (bad.length === 0) return { headline: `最近一次对账 ${when}：无异常`, ok: true, lines: [] };
  return {
    headline: `最近一次对账 ${when}：发现 ${String(bad.length)} 类异常，需要人工处理`,
    ok: false,
    lines: bad.map(([k, n]) => {
      const ids = run.samples[k] ?? [];
      return `${RECONCILE_CLASS_LABELS[k] ?? k}：${String(n)}${ids.length > 0 ? `（${ids.join('、')}）` : ''}`;
    }),
  };
}
