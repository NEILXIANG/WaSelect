/**
 * 职责：运营日志页的两个只读请求（剩余清单 3-2）。
 * @see contracts/api-contract.yaml 0.6.32（GET /admin/audit、GET /admin/reconciliation/latest）
 */
import { ApiError, NETWORK_ERROR_CODE } from '../api/errors.js';
import type { ReconciliationRun } from './view.js';

export type AdminApi = ReturnType<typeof import('../api/client.js').createAdminApi>;

export interface AuditQuery {
  page: number;
  /** 精确匹配，如 `admin:u-xxx`；空串 = 不过滤（不发参数，服务端对空串回 40001）。 */
  actor: string;
  /** 精确匹配订单 / 商品 id；空串 = 不过滤。 */
  target: string;
  /** 操作日期下界 / 上界（`YYYY-MM-DD`，日本时间、含当天；契约 0.6.53）；空串 / 不传 = 不限。 */
  from?: string;
  to?: string;
  /** 每页条数（20 / 50 / 100；不传 = `AUDIT_PAGE_SIZE`）。 */
  size?: number;
}

/**
 * 审计列表的默认每页条数（服务端上限 100，契约 0.6.53）。
 * @why 比其它列表页的 20 大：这是**日志**，运营翻它是为了"往下扫一段时间"，一屏 20 条要点的次数太多；
 *      20 / 50 / 100 三档都能选（体验审查 2026-10-15，P2-5 补的 `PageSizeSelect`）。
 */
export const AUDIT_PAGE_SIZE = 50;

export async function listAudit(
  api: AdminApi,
  q: AuditQuery,
): Promise<{ items: unknown[]; total: number }> {
  const params = new URLSearchParams({
    page: String(q.page),
    size: String(q.size ?? AUDIT_PAGE_SIZE),
  });
  if (q.actor.trim() !== '') params.set('actor', q.actor.trim());
  if (q.target.trim() !== '') params.set('target', q.target.trim());
  // 评估 P2（契约 0.6.53）：操作日期范围（JST 日历日、两端含当天）
  if (q.from !== undefined && q.from !== '') params.set('created_from', q.from);
  if (q.to !== undefined && q.to !== '') params.set('created_to', q.to);
  const resp = (await api({ path: `/api/v1/admin/audit?${params.toString()}` })) as {
    items?: unknown;
    total?: unknown;
  } | null;
  if (resp === null || !Array.isArray(resp.items) || typeof resp.total !== 'number') {
    throw new ApiError(NETWORK_ERROR_CODE, '审计列表响应形状与契约不符', '');
  }
  return { items: resp.items, total: resp.total };
}

export async function latestReconciliation(api: AdminApi): Promise<ReconciliationRun | null> {
  const resp = (await api({ path: '/api/v1/admin/reconciliation/latest' })) as {
    run?: unknown;
  } | null;
  if (resp === null || !('run' in resp)) {
    throw new ApiError(NETWORK_ERROR_CODE, '对账结果响应形状与契约不符', '');
  }
  return (resp.run ?? null) as ReconciliationRun | null;
}
