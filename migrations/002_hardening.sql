-- 002：地基加固（P1）——外键索引、状态域约束、审计表 append-only、ADR-29 缺失的两张日志表。
--
-- @why 这一批都不是"功能"，而是**防止未来某天静默出错**的约束。它们的共同点是：
--      缺了不会让任何测试变红，只会在数据量上来、或出事故要查审计时才暴露，届时已无法补救。
--
-- @limitation 一：**没有**给 `payments.status` / `shipments.status` 加 CHECK。
--              原因是 api-contract.yaml 里这两者**没有枚举定义**（只有订单状态与商品状态有）。
--              在这种地方"顺手编一套取值"是最危险的写法：契约一旦补上枚举，
--              数据库会开始拒绝合法数据，而这个约束在单人开发阶段不会有人注意到。
--              宁可暂时不约束，等 0.6 契约补枚举后再加——这条待办写在本文档末尾。
-- @limitation 二：新增 `user_events` / `admin_audit` 两张表后，实际表数由 13 变为 15，
--              与技术文档 v0.5 §3 的"13 张表"不一致。**技术文档需要同步补这两张表**。
--              加它们不是可选优化：ADR-29（已定的日志规范）要求三条日志流，
--              其中流 C 的用户行为落 `user_events`、流 B 的管理员操作落 `admin_audit`——
--              缺表意味着这两条流**根本无法实现**，属于硬阻塞，不是"以后再说"。
--              `outbox_events` 不在此列：清单 v1.2 附录 #15 已裁定 outbox 降级，不建表。
--
-- @see docs/代码注释规范与日志体系设计.md（三条流）、docs/地基搭建清单.md F7、ADR-29

-- Up migration

-- ── 1. 外键索引 ────────────────────────────────────────────────────────────
-- @why Postgres **不会**自动给外键列建索引。缺它的两个后果：
--      ① 父表删/改一行时，Postgres 必须对子表做**全表扫描**确认没有子行引用——
--         订单删除、商品下架这类操作会随着数据量线性变慢，而且只在生产数据量下才显现；
--      ② 按外键查（"这张单的所有明细"）永远走顺序扫描。
--      已有索引的不再重复建：orders(user_id,created_at)、order_events(order_id,at) 在 001 已建。
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses (user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments (order_id);

-- ── 2. 状态域约束 ──────────────────────────────────────────────────────────
-- @why `status VARCHAR(20)` 什么都能装。一旦某个 bug 写入 'payed'（拼写错），
--      这行订单就会从所有状态查询里消失——不报错、不报警，只是"用户看不到自己的订单了"。
--      取值与 packages/shared/src/enums.ts 的 ORDER_STATUS 逐字一致（10 态）。
ALTER TABLE orders
  ADD CONSTRAINT orders_status_domain CHECK (
    status IN ('created','pending_payment','paid','shipped','delivered',
               'completed','cancelled','expired','refunding','refunded')
  );

-- 契约已枚举：active / offline（见 api-contract.yaml /admin/products/{id}/status）
ALTER TABLE products
  ADD CONSTRAINT products_status_domain CHECK (status IN ('active','offline'));

-- ── 3. 审计表：ADR-29 流 B / 流 C 的落点 ───────────────────────────────────
-- @why 运行日志（流 A）可以采样、可以丢、可以到第三方；审计流与用户行为流**不能**。
--      它们必须落在我们自己的库里、与业务数据同库同事务，否则"什么时候改的价格、谁改的"
--      这类问题永远答不上来——而跨境业务里这正是争议与合规检查要问的第一句。
CREATE TABLE user_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT,
  session_id TEXT,
  event      VARCHAR(64) NOT NULL,
  -- 事件参数。**只存结构化字段，不存自由文本**：props 是查询面，塞进去的东西都要能被检索
  props      JSONB NOT NULL DEFAULT '{}',
  trace_id   TEXT,
  req_id     TEXT,
  path       VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_events_user_created ON user_events (user_id, created_at DESC);
CREATE INDEX idx_user_events_event_created ON user_events (event, created_at DESC);

CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     VARCHAR(64) NOT NULL,
  target     VARCHAR(128),
  before     JSONB,
  after      JSONB,
  trace_id   TEXT,
  req_id     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_audit_actor_created ON admin_audit (actor, created_at DESC);
CREATE INDEX idx_admin_audit_target ON admin_audit (target, created_at DESC);

-- ── 4. append-only：审计记录不可改 ──────────────────────────────────────────
-- @why 用**触发器**而不是"在应用里自觉不写 UPDATE"：自觉会失效，
--      而且最需要改审计记录的时刻（有人想掩盖一次误操作）正是自觉最不可靠的时刻。
--      也有人用"REVOKE UPDATE + 单独的应用角色"，那更彻底但要改连接角色与迁移账号，
--      当前单人开发阶段先用触发器（对所有连接生效，含超级用户），F7b 再评估角色方案。
-- @limitation 触发器挡不住 `TRUNCATE`（DDL 不走行级触发器）。
--      测试库重置依赖 TRUNCATE，这是有意的；生产严禁对审计表 TRUNCATE，靠权限与流程约束。
CREATE OR REPLACE FUNCTION deny_audit_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '审计表 % 只允许 INSERT：UPDATE/DELETE 被拒绝（append-only，见 ADR-29）', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

CREATE TRIGGER trg_user_events_append_only
  BEFORE UPDATE OR DELETE ON user_events
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

CREATE TRIGGER trg_admin_audit_append_only
  BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

-- 待办（不在本迁移内，需先改契约）：payments.status / shipments.status 的 CHECK，
-- 等 api-contract 0.6 补上这两个枚举后以 003 号迁移追加。

-- Down migration

DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON admin_audit;
DROP TRIGGER IF EXISTS trg_user_events_append_only ON user_events;
DROP TRIGGER IF EXISTS trg_order_events_append_only ON order_events;
DROP FUNCTION IF EXISTS deny_audit_modification();

DROP TABLE IF EXISTS admin_audit;
DROP TABLE IF EXISTS user_events;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_domain;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_domain;

DROP INDEX IF EXISTS idx_shipments_order;
DROP INDEX IF EXISTS idx_payments_order;
DROP INDEX IF EXISTS idx_order_items_product;
DROP INDEX IF EXISTS idx_order_items_order;
DROP INDEX IF EXISTS idx_addresses_user;
