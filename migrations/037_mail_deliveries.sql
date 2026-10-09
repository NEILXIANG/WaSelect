-- 037：订单通知邮件的**发信记录**（E-1，工程分析 2026-10-08 / AJ-419）——让"该发没发成"的邮件可以被 daily 找出来补发。
--
-- @why 事件总线是进程内、发后不等（server/src/adapters/event-bus.ts @limitation 一/二）：提交之后、发信之前进程退出，
--      那封信就永远不会发；服务商失败也只留一条日志。小程序订阅消息未做（等 AppID），邮件是买家**唯一**的主动通知。
--      全量 outbox（事务内写事件 + 投递 worker）是标准解，但要改每一处发事件的写路径；这里取最小版：
--      记录每次发信结果，daily 以订单 / 退款的**事实**为准反查"该有而没有 sent 记录"的，重新发出原事件。
-- @why 主键 = 发信幂等键（`事件:订单[:子键]`）：与服务商侧去重同一个键，补发与实时同一封信落同一行。
-- @why 不存邮箱（约束七）：要发给谁永远从 orders.contact_email 现取；last_error 由应用层打码后再写。
-- @limitation 只有结果、没有"排队中"：实时路径还没跑到 notify 就丢的，靠 daily 按事实反查补，不靠本表。
--
-- @see server/src/app/order-mail.ts（写入方）；server/src/app/mail-sweep.ts（daily 补发）

-- Up migration

CREATE TABLE IF NOT EXISTS mail_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  tag             VARCHAR(40) NOT NULL,
  status          VARCHAR(16) NOT NULL CONSTRAINT mail_deliveries_status_domain
                    CHECK (status IN ('sent', 'failed', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 1 CONSTRAINT mail_deliveries_attempts_positive CHECK (attempts >= 1),
  last_error      TEXT,
  first_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mail_deliveries_order ON mail_deliveries (order_id);

-- Down migration

DROP INDEX IF EXISTS idx_mail_deliveries_order;
DROP TABLE IF EXISTS mail_deliveries;
