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
};

export interface AuditRowView {
  id: number;
  timeText: string;
  actor: string;
  action: string;
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
        actor: String(i['actor'] ?? ''),
        action: String(i['action'] ?? ''),
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
