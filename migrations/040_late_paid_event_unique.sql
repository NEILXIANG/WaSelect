-- 040：迟到付款事件按 (order_id, note) 唯一（审计 BUG-13，2026-10-14，AJ-529）。
--
-- @why `mark-paid.ts` 记迟到付款用的是 `insert … where not exists`，它在事务外执行、没有锁可串行：
--      同一机构单号的两条迟到回调并发到达时，两边都看不到对方，于是写出两条 `late_paid` 事件。
--      退款按订单键执行不会双退，但"迟到付款待退"待办与时间线会出现重复。唯一索引让库来保证只有一条。
-- @why 部分索引（只管 status = 'late_paid'）：其它事件的 note 可以重复（例如多次"发起支付"），不该受约束。
-- @limitation 若库里已有重复的 late_paid 事件，建索引会失败（order_events 是 append-only，不能删）——
--      生产尚未上线，无存量；本地开发库若撞上，重建库即可。
--
-- @see server/src/app/mark-paid.ts recordLatePaid

-- Up migration

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_events_late_paid
  ON order_events (order_id, note)
  WHERE status = 'late_paid';

-- Down migration

DROP INDEX IF EXISTS uq_order_events_late_paid;
