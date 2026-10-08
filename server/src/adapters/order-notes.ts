/**
 * 职责：订单内部备注仓储（迁移 034，第一批⑤，AJ-396）——按单列出、追加一条。只有这两个动作。
 *
 * @why 没有"改 / 删"：表是 append-only（触发器拒 UPDATE / DELETE），仓储层也就不提供入口，
 *      免得有人写出一个"一调就 42501"的函数。写错了的处理方式是再追加一条更正。
 * @why 作者邮箱用 `left join users on 'admin:' || u.id = n.author` 现取，不在备注行里冗余存：
 *      管理员改了邮箱，旧备注跟着显示新邮箱（这里要的是"这是谁"，不是"当时登录用的哪个字符串"）。
 *      @tradeoff 用户行被删 / 没有邮箱时拿不到邮箱，调用方按"省略字段"处理，仍显示 author 原值。
 * @why created_at 由调用方传入（Clock 端口），不用库默认 now()：与 order_events 的写法一致，
 *      用例能控制时间，且同一请求里各处的"现在"是同一个值。
 * @limitation 没有分页：单张订单的备注量级是个位数到几十条；真到上百条再加 limit。
 * @limitation 同一单不加行锁：两位管理员同时追加，两条都会落库（这正是期望行为）。
 * @see migrations/034_order_notes.sql；app/admin-order-note-routes.ts
 */
import type { Db } from './db.js';

export interface OrderNoteRow {
  id: string;
  order_id: string;
  author: string;
  author_email: string | null;
  body: string;
  created_at: Date;
}

function toRow(r: Record<string, unknown>): OrderNoteRow {
  return {
    id: String(r['id']),
    order_id: String(r['order_id']),
    author: String(r['author']),
    author_email: typeof r['author_email'] === 'string' ? r['author_email'] : null,
    body: String(r['body']),
    created_at: r['created_at'] as Date,
  };
}

export async function listOrderNotes(db: Db, orderId: string): Promise<OrderNoteRow[]> {
  const rows = await db`
    select n.id, n.order_id, n.author, u.email as author_email, n.body, n.created_at
      from order_notes n
      left join users u on 'admin:' || u.id = n.author
     where n.order_id = ${orderId}
     order by n.created_at, n.id
  `;
  return rows.map(toRow);
}

export async function insertOrderNote(
  db: Db,
  note: { orderId: string; author: string; body: string; at: Date },
): Promise<OrderNoteRow> {
  const rows = await db`
    with ins as (
      insert into order_notes (order_id, author, body, created_at)
      values (${note.orderId}, ${note.author}, ${note.body}, ${note.at})
      returning id, order_id, author, body, created_at
    )
    select ins.*, u.email as author_email
      from ins left join users u on 'admin:' || u.id = ins.author
  `;
  const [r] = rows;
  if (r === undefined) throw new Error('order_notes insert returned no row');
  return toRow(r);
}
