/**
 * 职责：订单内部备注两条路由（第一批⑤，AJ-396，契约 0.6.42）。
 *
 * - `GET  /admin/orders/:id/notes` → 200 `{ items: OrderNote[] }`（按时间先后）
 * - `POST /admin/orders/:id/notes` `{ body }` → 201 `{ note: OrderNote }`
 *
 * @why 订单存在性先查一次再写：不查的话不存在的订单会撞外键（23503）→ 兜底层折成 40001 或 500，
 *      运营看到的是"参数错误"而不是"订单不存在"。多一次主键查询，换一个准确的 40400。
 * @why 审计**不手写**：挂在 `/api/v1/admin` 上的审计中间件对每次成功的写自动追加一行
 *      （admin-audit.ts 文件头 ①），after = 请求体（经 redact）。
 * @why 失败只打 info 级 `admin_order_note_rejected` 并带 reason（不带正文）：正文可能含买家电话 / 地址
 *      （售后沟通的原话），按约束七脱敏红线不进日志。
 * @limitation 只校验订单存在，不校验订单状态：任何状态（含已取消 / 已退款）都允许追加——
 *             售后沟通恰恰常发生在退款之后。
 * @see domain/order-note.ts；adapters/order-notes.ts；migrations/034_order_notes.sql
 */
import type { Express, Request } from 'express';
import type { Db } from '../adapters/db.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { insertOrderNote, listOrderNotes, type OrderNoteRow } from '../adapters/order-notes.js';
import { orderNoteGuard } from '../domain/order-note.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../ports/clock.js';
import { requireRole, type AuthConfig } from './auth.js';

export interface AdminOrderNoteRoutesDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  auth: AuthConfig;
  identity: IdentityCheck;
}

const actorOf = (req: Request): string => `admin:${req.auth?.sub ?? 'unknown'}`;

/** 对外形状：没有邮箱时**省略**键（与契约 0.6.40 的 actor_email 同口径），不回 null。 */
function noteView(n: OrderNoteRow): Record<string, unknown> {
  return {
    id: n.id,
    author: n.author,
    ...(n.author_email !== null ? { author_email: n.author_email } : {}),
    body: n.body,
    created_at: n.created_at.toISOString(),
  };
}

async function assertOrderExists(db: Db, id: string): Promise<void> {
  const [o] = await db`select 1 from orders where id = ${id}`;
  if (o === undefined) throw new AppError(40400, { order_id: id });
}

export function mountAdminOrderNoteRoutes(app: Express, deps: AdminOrderNoteRoutesDeps): void {
  const guard = requireRole('admin', deps.auth, { identity: deps.identity });

  app.get('/api/v1/admin/orders/:id/notes', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        await assertOrderExists(deps.db, id);
        const notes = await listOrderNotes(deps.db, id);
        res.json({ items: notes.map(noteView) });
      } catch (e) {
        next(e);
      }
    })();
  });

  app.post('/api/v1/admin/orders/:id/notes', guard, (req, res, next) => {
    void (async () => {
      try {
        const id = String(req.params.id);
        const g = orderNoteGuard((req.body as { body?: unknown } | null)?.body);
        if (!g.ok) {
          deps.logger.info('admin_order_note_rejected', { order_id: id, reason: g.reason });
          throw new AppError(g.code, { reason: g.reason, order_id: id });
        }
        await assertOrderExists(deps.db, id);
        const note = await insertOrderNote(deps.db, {
          orderId: id,
          author: actorOf(req),
          body: g.body,
          at: deps.clock.now(),
        });
        deps.logger.info('admin_order_note_added', {
          result: 'ok',
          order_id: id,
          note_id: note.id,
        });
        res.status(201).json({ note: noteView(note) });
      } catch (e) {
        next(e);
      }
    })();
  });
}
