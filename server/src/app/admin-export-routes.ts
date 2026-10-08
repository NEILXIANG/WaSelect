/**
 * 职责：`GET /api/v1/admin/exports/{kind}` —— 订单 / 待采购 / 待发货报关三类 CSV（剩余清单 3-3）。
 *
 * @why 响应是 JSON `{filename, csv}` 而不是直接回 `text/csv` 附件：管理端的请求封装（鉴权头、trace、40101 出口、错误码）
 *      全按 JSON 写；回附件就要在前端另造一条 fetch 路径。CSV 体量（日百单）放进 JSON 字符串无压力。
 * @why **导出必须进审计**：审计中间件只记写操作，而这三张表含收件人姓名 / 电话 / 地址（PII 批量出库）。
 *      "谁在什么时候导了多少行"必须查得到——这里显式 append 一行，target = kind，after = {rows}。
 * @limitation 审计写失败不阻断导出（记 error 日志）：与审计中间件同口径，导出已经发生，拦下响应只会让人重试。
 * @why 「导出所选」（AJ-407，契约 0.6.48）是**同一个端点加一个过滤参数** `order_ids`，不另开路径：
 *      三类表、CSV 编码、审计、文件名全部复用，"所选"与"全部"导出的列永远一致。
 *      审计 after 多记 `selected`（所选单数）：行数 ≠ 所选数（未知 id / 测试单 / 非 paid 不出），只记行数查不出"导了哪批"。
 * @limitation 审计不记**具体是哪些 id**（只记个数）：与原有"只记行数"同口径——要追具体哪批，看同一 trace_id 的访问日志。
 * @limitation 下单日期筛选（created_from / created_to）**未接入导出**：见 docs/自主决策记录.md AJ-407 ③（有条件延期）。
 * @see adapters/exports.ts；domain/csv.ts；contracts/api-contract.yaml 0.6.32 / 0.6.48
 */
import type { Express } from 'express';
import { EXPORT_IDS_MAX, ORDER_STATUS } from '@waselect/shared';
import { AppError } from '../errors.js';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { createAdminAuditStore } from '../adapters/admin-audit.js';
import { EXPORT_KINDS, exportTable, type ExportKind } from '../adapters/exports.js';
import { toCsv } from '../domain/csv.js';
import { currentContext } from '../context.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';

export interface AdminExportRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
}

/** 单个订单 id 的长度上限（与批量发货 `order_id_invalid` 同口径：64 字）。 */
const ORDER_ID_MAX_CHARS = 64;

/**
 * `order_ids` 查询参数 → 去重后的 id 数组；没给 → undefined。
 * @why 非法一律 40001、**不容错**：重复参数（Express 解析成数组）、空串、空段（`a,`）——容错会让前端拼错的请求
 *      静默变成"少导几单"或"导出全部"，运营拿着少了 / 多了的表去采购报关，没有任何报错。
 * @why 去重后再判上限：同一单勾两次不是错误，上限框的是"会进 SQL 的不同 id 有多少"。
 */
export function parseOrderIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new AppError(40001, { reason: 'order_ids_invalid' });
  const out: string[] = [];
  for (const id of raw.split(',')) {
    if (id === '' || id.length > ORDER_ID_MAX_CHARS) {
      throw new AppError(40001, { reason: 'order_ids_invalid' });
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > EXPORT_IDS_MAX) throw new AppError(40001, { reason: 'order_ids_too_many' });
  return out;
}

export function mountAdminExportRoutes(app: Express, deps: AdminExportRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });
  const audit = createAdminAuditStore(deps.db);

  app.get('/api/v1/admin/exports/:kind', guard, (req, res, next) => {
    void (async () => {
      try {
        const kind = String(req.params.kind);
        if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
          throw new AppError(40001, { reason: 'export_kind_invalid' });
        }
        const rawStatus = req.query['status'];
        if (
          rawStatus !== undefined &&
          !(
            typeof rawStatus === 'string' && (ORDER_STATUS as readonly string[]).includes(rawStatus)
          )
        ) {
          throw new AppError(40001, { reason: 'status_invalid' });
        }
        const orderIds = parseOrderIds(req.query['order_ids']);
        const table = await exportTable(deps.db, kind as ExportKind, {
          status: rawStatus,
          orderIds,
        });
        const { trace_id: traceId, req_id: reqId } = currentContext();
        try {
          await audit.append({
            actor: `admin:${req.auth?.sub ?? 'unknown'}`,
            // 与审计中间件同形态（去 /api/v1 前缀，admin-audit.ts）：审计页按 action 过滤时只认一种写法（P2-23）
            action: 'GET /admin/exports/:kind',
            target: kind,
            before: null,
            after: {
              rows: table.rows.length,
              ...(orderIds !== undefined ? { selected: orderIds.length } : {}),
            },
            statusCode: 200,
            traceId: traceId ?? null,
            reqId: reqId ?? null,
          });
        } catch (e) {
          deps.logger.error('admin_export_audit_failed', {
            result: 'failed',
            ctx: { kind, error: e instanceof Error ? e.message : String(e) },
          });
        }
        const day = deps.clock.now().toISOString().slice(0, 10).replace(/-/g, '');
        res.json({ filename: `${kind}-${day}.csv`, csv: toCsv(table.header, table.rows) });
      } catch (e) {
        next(e);
      }
    })();
  });
}
