/**
 * 职责：批量发货 `POST /api/v1/admin/orders/ship-batch`（AJ-401，契约 0.6.45）——
 *      一次最多 {@link SHIP_BATCH_MAX} 单，**逐单**执行单单发货的同一份逻辑（ship-order.ts），按行回结果。
 *
 * @why **逐单一个事务、允许部分成功**，而不是整批一个事务：
 *      整批事务里一行坏数据（单号打错、那单刚被拒付锁住）就把其余 49 单一起回滚，
 *      运营看到"全失败"会再提交一次——这次好的那些已经……没发（回滚了），于是来回折腾；
 *      更糟的是整批事务要同时持 50 把行锁，与单单发货 / 退款互相等待的面成倍放大。
 *      逐单事务让"发成了的就是发成了"——每单要么整单迁移 + 写事件，要么什么都没动（不留半成品）。
 * @why **串行**而不是 Promise.all：连接池 `max: 10` 与支付回调共用，并行 50 个事务会把回调挤出去；
 *      且并行时结果顺序与日志交错，排障更难。50 单串行在真库上是百毫秒级（见 limits.ts SHIP_BATCH_MAX）。
 * @why 并发安全**不另起一把锁**：两个管理员同时批量发重叠的单，靠的是单单那一把——
 *      `lockAdminOrder`（for update）+ `markShipped ... where status = 'paid'`。每个事务只锁一行，
 *      所以两批顺序相反也不会死锁（db 用例「重叠且反序的两批并发」钉住）。
 * @why 结构错误（items 不是数组 / 空 / 超上限 / order_id 非法 / 同一单重复）**整次拒绝**（40001），一单都不发：
 *      这些是"请求本身不成立"，逐行处理会让"重复的那单发了一次、第二次 40902"看起来像并发冲突。
 *      逐行的问题（承运商 / 运单号缺失或超长、状态、拒付、测试单、不存在）按行回，不连累别行。
 * @why 审计：一行 admin_audit，after = **逐单结果**（`setAuditAfter`）而不是请求体——
 *      请求体会把失败的单也记成"发了"。一单都没成 → `skipAudit`（没有发生的改动不进审计）。
 *      逐单的"谁发的"另有 order_events.actor（与单单发货同一条）。
 *
 * @limitation 一：HTTP 恒 200（结构错误除外）：部分成功没有合适的单一状态码，调用方必须看 `results`。
 * @limitation 二：没有幂等键（与单单发货一致）：网络断开后重提，上次已成功的行回 40902 `status_shipped`。
 *              前端按 reason 转述为"已发货"，不算失败。
 * @limitation 三：请求中途进程崩溃 → 已提交的单是真发了、客户端拿不到结果；只能回列表看状态（与单单同）。
 * @see app/ship-order.ts；packages/shared/src/limits.ts（SHIP_BATCH_MAX）；docs/自主决策记录.md AJ-401
 */
import type { Express } from 'express';
import { SHIP_BATCH_MAX } from '@waselect/shared';
import { AppError } from '../errors.js';
import type { IdentityCheck } from '../adapters/identity.js';
import type { AuthConfig } from './auth.js';
import { requireRole } from './auth.js';
import { setAuditAfter, setAuditTarget, skipAudit } from './admin-audit.js';
import { adminActor } from './admin-order-routes.js';
import { shipOrder, type ShipOrderDeps, type ShippedView } from './ship-order.js';

/**
 * order_id 的长度上限（入口挡，不进 SQL / 日志）。
 * @why 订单 id 是服务端生成的短串（`orders.id` TEXT，实际 < 40 字）；64 留足余量，
 *      又挡住"客户端塞几 KB 进日志 / 错误归类"（七类必查 G）。
 */
const ORDER_ID_MAX = 64;

export type ShipBatchItemResult =
  | ({ ok: true } & ShippedView)
  | { order_id: string; ok: false; code: number; message: string; reason: string };

/** 结构校验：通过 → 每项的 order_id（已 trim）；不通过 → 抛 40001（整次拒绝）。 */
function parseItems(body: unknown): { orderId: string; raw: unknown }[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new AppError(40001, { reason: 'items_required' });
  if (items.length === 0) throw new AppError(40001, { reason: 'batch_empty' });
  if (items.length > SHIP_BATCH_MAX) {
    throw new AppError(40001, { reason: 'batch_too_large', ctx: { max: SHIP_BATCH_MAX } });
  }
  const seen = new Set<string>();
  return items.map((raw: unknown) => {
    const v = (raw as { order_id?: unknown } | null)?.order_id;
    const orderId = typeof v === 'string' ? v.trim() : '';
    if (orderId === '' || orderId.length > ORDER_ID_MAX) {
      throw new AppError(40001, { reason: 'order_id_invalid' });
    }
    if (seen.has(orderId)) throw new AppError(40001, { reason: 'duplicate_order_id' });
    seen.add(orderId);
    return { orderId, raw };
  });
}

export function mountAdminShipBatchRoutes(
  app: Express,
  deps: ShipOrderDeps & { auth: AuthConfig; identity: IdentityCheck },
): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.post('/api/v1/admin/orders/ship-batch', guard, (req, res, next) => {
    void (async () => {
      try {
        const items = parseItems(req.body);
        const actor = adminActor(req);
        const results: ShipBatchItemResult[] = [];
        for (const { orderId, raw } of items) {
          try {
            const shipped = await shipOrder(deps, orderId, raw, actor, { batch: true });
            results.push({ ok: true, ...shipped });
          } catch (e) {
            const known = e instanceof AppError;
            const reasonRaw = known
              ? (e.details as { reason?: unknown } | undefined)?.reason
              : null;
            const reason = typeof reasonRaw === 'string' ? reasonRaw : 'internal';
            const code = known ? e.code : 50000;
            // 非 AppError（库断开、触发器报错）也只记这一单：事务已回滚，别的单照常继续
            if (known) {
              deps.logger.warn('admin_order_ship_batch_item_failed', {
                result: 'failed',
                order_id: orderId,
                ctx: { code, reason },
              });
            } else {
              deps.logger.error('admin_order_ship_batch_item_failed', {
                result: 'failed',
                order_id: orderId,
                err: e,
                ctx: { code, reason },
              });
            }
            const message = known ? e.message : '服务器内部错误';
            results.push({ order_id: orderId, ok: false, code, message, reason });
          }
        }
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.length - succeeded;
        deps.logger.info('admin_order_ship_batch', {
          result: failed === 0 ? 'ok' : 'partial',
          ctx: { total: results.length, succeeded, failed },
        });
        if (succeeded === 0) skipAudit(res);
        else {
          // ADM-8（AJ-470）：运营日志的"对象"列此前为空——批量没有单个 id，记成功数 / 总数
          setAuditTarget(res, `batch:${String(succeeded)}/${String(results.length)}`);
          setAuditAfter(res, { results });
        }
        res.json({ results, succeeded, failed });
      } catch (e) {
        next(e);
      }
    })();
  });
}
